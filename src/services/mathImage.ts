// services/mathImage.ts
// LaTeX -> PNG for the Word export (step 4: equations are pictures in DOCX first).
// MathJax draws the equation as SVG paths (no fonts needed), resvg turns the SVG into a
// transparent PNG at 3x size so it stays sharp in print.

export interface MathPicture {
  png: Buffer;
  /** Size on the page, in CSS pixels (96 per inch), at the requested font size. */
  width: number;
  height: number;
  /** How far the equation hangs below the text baseline, in CSS pixels. */
  depth: number;
}

const PNG_SCALE = 3;
const EX_PER_EM = 0.431; // x-height of the MathJax TeX font, in em
const MAX_WIDTH_PX = 600; // A4 text width with 1.25" margins is about 602 px

// The equation packages are loaded the first time an equation is drawn, not when the server starts:
// if the native PNG module is missing on a server, only Word equations stop (they show as text)
// instead of the whole backend failing to start.
let engine: { html: any; adaptor: any; Resvg: any } | null = null;

function getEngine() {
  if (!engine) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { mathjax } = require('mathjax-full/js/mathjax');
    const { TeX } = require('mathjax-full/js/input/tex');
    const { SVG } = require('mathjax-full/js/output/svg');
    const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor');
    const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html');
    require('mathjax-full/js/input/tex/base/BaseConfiguration');
    require('mathjax-full/js/input/tex/ams/AmsConfiguration');
    require('mathjax-full/js/input/tex/newcommand/NewcommandConfiguration');
    require('mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration');
    require('mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration');
    require('mathjax-full/js/input/tex/cancel/CancelConfiguration');
    require('mathjax-full/js/input/tex/color/ColorConfiguration');
    const { Resvg } = require('@resvg/resvg-js');
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    const tex = new TeX({ packages: ['base', 'ams', 'newcommand', 'noundefined', 'boldsymbol', 'cancel', 'color'] });
    const svg = new SVG({ fontCache: 'none' });
    engine = { html: mathjax.document('', { InputJax: tex, OutputJax: svg }), adaptor, Resvg };
  }
  return engine;
}

const cache = new Map<string, MathPicture>();

/** Renders one equation. Throws when MathJax cannot read the formula (the caller shows it as text). */
export function renderMathPicture(latex: string, display: boolean, fontPx: number): MathPicture {
  const key = `${display ? 'd' : 'i'}|${fontPx}|${latex}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const { html, adaptor, Resvg } = getEngine();
  const node = html.convert(latex, { display, em: 16, ex: 8, containerWidth: 1280 });
  let svg: string = adaptor.innerHTML(node);
  if (!svg.includes('<svg') || svg.includes('data-mjx-error')) throw new Error('MathJax could not render this formula');

  const num = (re: RegExp) => {
    const m = svg.match(re);
    return m ? parseFloat(m[1]) : NaN;
  };
  const wEx = num(/<svg[^>]*\swidth="([\d.]+)ex"/);
  const hEx = num(/<svg[^>]*\sheight="([\d.]+)ex"/);
  const vEx = num(/vertical-align:\s*(-?[\d.]+)ex/);
  if (!isFinite(wEx) || !isFinite(hEx)) throw new Error('Unexpected MathJax output');

  const exPx = EX_PER_EM * fontPx;
  let width = wEx * exPx;
  let height = hEx * exPx;
  let depth = isFinite(vEx) ? Math.max(0, -vEx * exPx) : 0;
  if (width > MAX_WIDTH_PX) {
    const k = MAX_WIDTH_PX / width;
    width *= k; height *= k; depth *= k;
  }

  svg = svg
    .replace(/(<svg[^>]*\s)width="[\d.]+ex"/, `$1width="${(width * PNG_SCALE).toFixed(2)}"`)
    .replace(/(<svg[^>]*\s)height="[\d.]+ex"/, `$1height="${(height * PNG_SCALE).toFixed(2)}"`)
    .replace(/currentColor/g, '#000000');
  if (!/<svg[^>]*xmlns=/.test(svg)) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');

  const png = Buffer.from(new Resvg(svg).render().asPng());
  const picture: MathPicture = { png, width, height, depth };
  if (cache.size > 2000) cache.clear();
  cache.set(key, picture);
  return picture;
}