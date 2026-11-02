import type { ListingPage, RemoteRepo } from "#/lib/catalog";

/** Both hosts are asked for this many repos a page; a shorter page is the last one. */
export const PAGE_SIZE = 100;

/** Pages of 100; ten covers a thousand repos, which is plenty before a listing becomes unwieldy. */
export const MAX_PAGES = 10;

/**
 * Fetches a paginated listing, revalidating pages we already hold. `request` returns the raw response (and
 * throws for anything but 200 and 304). A page whose ETag still matches comes back as `304 Not Modified`, which
 * GitHub doesn't count against the rate limit, so a check that finds nothing new costs no quota and no download.
 * Every page is asked about, since a repo that changes can move to another page.
 */
export async function fetchListingPages(
  request: (page: number, etag: string | null) => Promise<Response>,
  parse: (body: unknown) => RemoteRepo[],
  previous: readonly ListingPage[],
): Promise<ListingPage[]> {
  const pages: ListingPage[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const held = previous[page - 1];
    const response = await request(page, held?.etag ?? null);
    let next: ListingPage;
    if (response.status === 304) {
      if (!held) throw new Error("The host answered 304 Not Modified to a request with no ETag.");
      next = held;
    } else {
      next = { etag: response.headers.get("etag"), repos: parse(await response.json()) };
    }
    pages.push(next);
    if (next.repos.length < PAGE_SIZE) break;
  }
  return pages;
}
