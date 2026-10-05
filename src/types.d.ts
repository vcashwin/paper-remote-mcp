// Ambient declarations for the Paper web-app globals we touch inside
// `page.evaluate`. These live in the browser page, not in Node — this file just
// teaches the type checker about them.

export {};

declare global {
  interface Window {
    /** Lazy promise that resolves to Paper's MCP handlers instance. */
    resolveMCPHandlers?: Promise<any> | undefined;
    /** The handlers instance, once built. */
    mcpHandlers?: any;
    /** Optional staging-only demo mock state, installed before page scripts. */
    __apiMockerEnabled?: boolean;
    __serverStartTime?: number;
    __clientStartTime?: number;
    __apiMocker?: any;
  }

  interface XMLHttpRequest {
    /** URL captured by the staging-only demo mock. */
    __apiMockerUrl?: string | URL;
  }

  interface Navigator {
    /** WebMCP API Paper sniffs for; we stub it to enter WebMCP mode. */
    modelContext?: any;
  }
}
