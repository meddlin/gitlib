/** A hosting service that can't be listed because gitlib isn't set up for it, as opposed to a request that failed. */
export class ProviderSetupError extends Error {
  override name = "ProviderSetupError";
}
