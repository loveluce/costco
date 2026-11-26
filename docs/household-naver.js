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

export {parseShoppingListing as parseNaverListing} from './household-shopping.js';
