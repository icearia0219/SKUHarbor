/** Reads flags without importing config.ts (which bootstraps private user data). */
export const ecommerceEnabled = () =>
  process.env.OPENDOT_ECOMMERCE_OPS?.toLowerCase() === 'true';
export function ecommerceLimits() {
  return {
    max_assets: 20,
    max_file_bytes: 50 * 1024 * 1024,
    max_context_bytes: 96 * 1024,
    max_generations: 2,
    max_output_tokens: 4096,
    max_elapsed_ms: 10 * 60 * 1000,
  };
}
