// services/mathImage.ts
// LaTeX -> PNG for the Word export (step 4: equations are pictures in DOCX first).
// MathJax draws the equation as SVG paths (no fonts needed), resvg turns the SVG into a
// transparent PNG at 3x size so it stays sharp in print.

import { mathjax } from 'mathjax-full/js/mathjax';
import { TeX } from 'mathjax-full/js/input/tex';
import { SVG } from 'mathjax-full/js/output/svg';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html';
import 'mathjax-full/js/input/tex/base/BaseConfiguration';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration';
import 'mathjax-full/js/input/tex/newcommand/NewcommandConfiguration';
import 'mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration';
import 'mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration';
import 'mathjax-full/js/input/tex/cancel/CancelConfiguration';
import 'mathjax-full/js/input/tex/color/ColorConfiguration';
import { Resvg } from '@resvg/resvg-js';

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

let engine: { html: any; adaptor: any } | null = null;

function getEngine() {
  if (!engine) {
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    const tex = new TeX({ packages: ['base', 'ams', 'newcommand', 'noundefined', 'boldsymbol', 'cancel', 'color'] });
    const svg = new SVG({ fontCache: 'none' });
    engine = { html: mathjax.document('', { InputJax: tex, OutputJax: svg }), adaptor };
  }
  return engine;
}

const cache = new Map<string, MathPicture>();

/** Renders one equation. Throws when MathJax cannot read the formula (the caller shows it as text). */
export function renderMathPicture(latex: string, display: boolean, fontPx: number): MathPicture {
  const key = `${display ? 'd' : 'i'}|${fontPx}|${latex}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const { html, adaptor } = getEngine();
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