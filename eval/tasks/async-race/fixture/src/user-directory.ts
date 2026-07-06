import { AsyncCache } from "./cache";

export interface UserProfile {
  id: string;
  name: string;
}

export type FetchUser = (id: string) => Promise<UserProfile>;

/**
 * UserDirectory looks up user profiles through a caller-supplied fetch
 * function, memoizing results per user id via AsyncCache. Request handlers
 * that look up the same user id concurrently (e.g. rendering a page that
 * references the same author twice) should not cause duplicate fetches.
 */
export class UserDirectory {
  private readonly cache = new AsyncCache<string, UserProfile>();

  constructor(private readonly fetchUser: FetchUser) {}

  getUser(id: string): Promise<UserProfile> {
    return this.cache.getOrLoad(id, () => this.fetchUser(id));
  }

  /** Forces the next getUser(id) call to re-fetch, even if cached. */
  refreshUser(id: string): void {
    this.cache.invalidate(id);
  }

  get stats() {
    return this.cache.stats;
  }
}
