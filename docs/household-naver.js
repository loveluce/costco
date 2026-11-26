function searchUrl(base, query) {
  const keyword = String(query ?? '').replace(/\s+/gu, ' ').trim();
  if (!keyword) return '';
  const url = new URL(base);
  url.searchParams.set('query', keyword);
  return url.href;
}

export function naverShoppingUrl(query) {
  return searchUrl('https://search.shopping.naver.com/search/all', query);
}

export function naverSearchUrl(query) {
  return searchUrl('https://search.naver.com/search.naver', query);
}

const itemLabel = /^(?:상품\s*판매가(?:격)?|판매가(?:격)?|상품\s*(?:가격|금액|가))\s*[:：]?\s*/u;
const shippingLabel = /^(?:기본\s*)?(?:배송비|배송료)\s*[:：]?\s*/u;
const quantityLabel = /^(?:총\s*(?:구성\s*)?수량|총\s*개수|포장\s*(?:수량|규격)|구성\s*수량|상품\s*구성|입수량|구성|총(?=\s*\d))\s*[:：]?\s*/u;
const won = /^(\d{1,3}(?:,\d{3})+|\d+)\s*원$/u;
const count = /^(\d+)\s*(?:개(?:입)?|입)$/u;
const inlineBoundary = /(\d[\d,]*\s*(?:원|개입?|입)|무료(?:\s*배송)?)\s+(?=(?:판매가|상품(?:가|\s*가격)|(?:기본\s*)?배송[비료]|총\s*(?:수량|개수)|구성\s*수량)\s*[:：]?\s*(?:\d|무료))/gu;

function parseWon(text) {
  const match = won.exec(text);
  if (!match) return null;
  const value = Number(match[1].replace(/,/gu, ''));
  return Number.isSafeInteger(value) && value <= 1e9 ? value : null;
}

function singleValue(values) {
  return values.size === 1 ? [...values][0] : null;
}

/** Read only explicitly labelled values from one offer pasted by the shopper. */
export function parseNaverListing(text) {
  const content = String(text ?? '').normalize('NFKC').slice(0, 30000);
  const parts = content.replace(inlineBoundary, '$1\n').split(/[\n\r\t|·]+/u).map(value => value.trim()).filter(Boolean);
  const prices = new Set(), shipRates = new Set(), counts = new Set();
  for (const [i, part] of parts.entries()) {
    const priceField = itemLabel.exec(part);
    const shippingField = shippingLabel.exec(part);
    const countField = quantityLabel.exec(part);
    const match = priceField || shippingField || countField;
    if (!match) {
      if (/^무료\s*배송$/u.test(part)) shipRates.add(0);
      continue;
    }
    const value = part.slice(match[0].length).trim() || parts[i + 1] || '';
    if (priceField) {
      const price = parseWon(value);
      prices.add(price !== null && price > 0 ? price : null);
    } else if (shippingField) {
      shipRates.add(/^무료(?:\s*배송)?$/u.test(value) ? 0 : parseWon(value));
    } else {
      const countMatch = count.exec(value);
      const n = countMatch ? Number(countMatch[1]) : null;
      counts.add(n > 0 && n <= 1e9 ? n : null);
    }
  }
  // Conditions can be a separate line following the free-delivery badge.
  const conditionalShipping = /(?:조건부|착불|선결제|도서\s*산간|제주|도서지역|묶음\s*배송|멤버십|이상\s*(?:구매|주문|시|무료)|회원\s*(?:가입\s*)?(?:시\s*)?무료|배송비\s*별도)/u.test(content);
  return {
    price: singleValue(prices),
    shipping: conditionalShipping ? null : singleValue(shipRates),
    pieces: singleValue(counts)
  };
}
