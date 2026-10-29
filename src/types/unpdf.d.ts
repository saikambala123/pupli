/**
 * Minimal ambient declaration for `unpdf` so the TypeScript compiler is happy
 * without forcing an upstream fix to the library's `exports` map (which the
 * runtime resolves fine, but `moduleResolution: bundler` trips on).
 */
declare module "unpdf" {
  export interface PDFTextItem {
    str: string;
    dir?: string;
    transform?: number[];
    width?: number;
    height?: number;
    fontName?: string;
    hasEOL?: boolean;
  }
  export async function extractTextItems(
    doc: any,
    opts?: { mergePages?: boolean; first?: number; last?: number }
  ): Promise<{
    text: string;
    /** Items grouped per page. `items[i]` is the array of items on page i. */
    items: PDFTextItem[][];
    totalPages: number;
    metadata?: any;
  }>;
  export async function getDocumentProxy(data: ArrayBuffer | Uint8Array | string): Promise<any>;
  export async function extractText(
    doc: any,
    opts?: { mergePages?: boolean; first?: number; last?: number }
  ): Promise<{ text: string; totalPages: number }>;
  export async function getMeta(doc: any): Promise<{ info: any; metadata: any }>;
}
