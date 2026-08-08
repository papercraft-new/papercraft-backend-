declare module 'html-to-docx' {
  interface HtmlToDocxOptions {
    orientation?: 'portrait' | 'landscape';
    margins?: {
      top?: number;
      right?: number;
      bottom?: number;
      left?: number;
      header?: number;
      footer?: number;
      gutter?: number;
    };
    title?: string;
    pageNumber?: boolean;
    header?: boolean;
    footer?: boolean;
    font?: string;
    fontSize?: number;
    table?: {
      row?: {
        cantSplit?: boolean;
      };
    };
  }

  function HTMLtoDOCX(
    htmlString: string,
    headerHTMLString?: string | null,
    options?: HtmlToDocxOptions,
    footerHTMLString?: string | null
  ): Promise<Buffer | ArrayBuffer>;

  export = HTMLtoDOCX;
}