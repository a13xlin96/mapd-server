const mockCache = new Map();
jest.mock('../lib/cache', () => ({
  getCached:jest.fn(async key => mockCache.get(key)),
  setCache:jest.fn(async (key, value) => mockCache.set(key, value)),
}));
jest.mock('../lib/providerRuntime', () => ({withProvider:jest.fn(async (_provider, run) => run({deadline:Date.now() + 10000}))}));
jest.mock('axios', () => ({post:jest.fn()}));
const axios = require('axios');
const {getCached, setCache} = require('../lib/cache');
const {searchGooglePlaces} = require('../enrich/places');
let originalKey;
beforeAll(() => { originalKey = process.env.GOOGLE_PLACES_API_KEY; process.env.GOOGLE_PLACES_API_KEY = 'test-only'; });
afterAll(() => {
  if (originalKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = originalKey;
});
beforeEach(() => { mockCache.clear(); jest.clearAllMocks(); });

test.each([
  ['unrestricted', undefined, undefined, 'places:search:ngam hanoi'],
  ['biased', {lat:21.03, lng:105.85}, undefined, 'places:search:ngam hanoi@21.03,105.85'],
  ['restricted', undefined, {low:{lat:21, lng:105.8}, high:{lat:21.1, lng:105.9}}, 'places:search:ngam hanoi#rect:21.00,105.80-21.10,105.90'],
])('Vietnamese %s search has its own reusable cache entry', async (_label, bias, restriction, key) => {
  const original = [{place_id:'ngam', name:'Immersion Coffee'}];
  const otherLanguage = [{place_id:'ngam', name:'另一種語言'}];
  mockCache.set(key, original);
  mockCache.set(`${key}#language:zh-tw`, otherLanguage);
  axios.post.mockResolvedValue({data:{places:[{
    id:'ngam', displayName:{text:'ngâm CAFE'}, formattedAddress:'Hanoi, Việt Nam',
    location:{latitude:21.03, longitude:105.85},
    addressComponents:[{longText:'Việt Nam', shortText:'VN', types:['country']}],
  }]}});

  expect(await searchGooglePlaces('ngam Hanoi', bias, restriction)).toBe(original);
  const localized = await searchGooglePlaces('ngam Hanoi', bias, restriction, {languageCode:'vi'});
  expect(localized[0]).toMatchObject({name:'ngâm CAFE', address_components:[{long_name:'Việt Nam', short_name:'VN', types:['country']}]});
  expect(axios.post.mock.calls[0][1]).toMatchObject({textQuery:'ngam Hanoi', pageSize:5, languageCode:'vi'});
  expect(setCache).toHaveBeenCalledWith(`${key}#language:vi`, localized, 7 * 24 * 60 * 60);
  expect(await searchGooglePlaces('ngam Hanoi', bias, restriction, {languageCode:'vi'})).toBe(localized);
  expect(await searchGooglePlaces('ngam Hanoi', bias, restriction)).toBe(original);
  expect(await searchGooglePlaces('ngam Hanoi', bias, restriction, {languageCode:'zh-TW'})).toBe(otherLanguage);
  expect(axios.post).toHaveBeenCalledTimes(1);
});

test('Vietnamese failures are not cached and unsupported languages remain rejected', async () => {
  axios.post.mockRejectedValue({response:{status:429}});
  await expect(searchGooglePlaces('ngam Hanoi', undefined, undefined, {languageCode:'vi'})).rejects.toMatchObject({code:'rate_limited'});
  expect(setCache).not.toHaveBeenCalled();
  getCached.mockClear();
  await expect(searchGooglePlaces('ngam Hanoi', undefined, undefined, {languageCode:'unsupported'})).rejects.toMatchObject({code:'invalid_response'});
  expect(getCached).not.toHaveBeenCalled();
  expect(axios.post).toHaveBeenCalledTimes(1);
});
