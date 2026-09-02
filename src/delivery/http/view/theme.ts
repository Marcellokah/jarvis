/** Every design token, checked by the theme test against both schemes. */
export const TOKEN_NAMES = [
  "--hatter", "--lap", "--racs", "--szoveg", "--halvany",
  "--jel", "--jel-halk", "--vaz", "--riado",
] as const;

/**
 * The page is an instrument, and it shows its own signal quality.
 *
 * Every hard bug this project has had was a number that looked real and was
 * not, so colour carries exactly one meaning each: `--jel` is measured data
 * and nothing else, `--vaz` is chrome and never data, `--riado` is a channel
 * that was due and did not arrive, and never decoration. What was not
 * measured has no hue at all and does not animate — the absence is what you
 * see, because nothing happens there.
 */
export const STYLE = `
:root {
  color-scheme: dark light;
  --hatter: #07090E; --lap: #0E131C; --racs: #18212E;
  --szoveg: #DCE3EE; --halvany: #6C7891;
  --jel: #FFA23C; --jel-halk: rgba(255,162,60,.18);
  --vaz: #4B7A8C; --riado: #FF3D7F;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --text: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root {
    --hatter: #E9ECF1; --lap: #FFFFFF; --racs: #CFD5DF;
    --szoveg: #0E131C; --halvany: #626D80;
    --jel: #A85400; --jel-halk: rgba(168,84,0,.14);
    --vaz: #2C5766; --riado: #C1004E;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--hatter); color: var(--szoveg);
  font: 16px/1.65 var(--text); -webkit-font-smoothing: antialiased; }

/* ---- navigáció: asztalon bal sáv, telefonon alsó sor ---- */
nav { display: flex; gap: .25rem; position: fixed; inset: auto 0 0 0; z-index: 2;
  background: var(--lap); border-top: 1px solid var(--racs); padding: .4rem; }
nav a.menu { flex: 1; text-align: center; padding: .6rem .4rem; border-radius: .25rem;
  color: var(--halvany); text-decoration: none;
  font: 600 .68rem/1.4 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
nav a.menu[aria-current="page"] { color: var(--vaz); background: var(--hatter); }
/* A lámpa a menüpont alatt: ég, ha a szekciónak van most mit mutatnia. */
nav a.menu.jelzo::after { content: ""; display: block; width: 4px; height: 4px;
  border-radius: 50%; margin: .35rem auto 0; background: var(--racs); }
nav a.menu.jelzo.el::after { background: var(--jel); }
@media (min-width: 46rem) {
  nav { inset: 0 auto 0 0; width: 8.5rem; flex-direction: column; justify-content: flex-start;
    border-top: 0; border-right: 1px solid var(--racs); padding: 2rem .5rem; gap: .15rem; }
  nav a.menu { flex: 0 0 auto; text-align: left; padding: .55rem .7rem; }
  nav a.menu.jelzo::after { display: inline-block; margin: 0 0 .15rem .5rem; }
}

/* ---- lap ---- */
.lap { max-width: 48rem; margin: 0 auto; padding: 1.5rem 1.25rem 7rem; }
@media (min-width: 46rem) { .lap { padding: 2.5rem 2rem 4rem 10.5rem; max-width: 58rem; } }

/* ---- állapotsáv ---- */
.allapot { display: flex; flex-wrap: wrap; gap: .3rem 1.1rem; align-items: baseline;
  padding-bottom: 1rem; margin-bottom: 1.75rem; border-bottom: 1px solid var(--racs);
  font: .72rem/1.6 var(--mono); letter-spacing: .05em; }
.allapot .datum { color: var(--vaz); text-transform: uppercase; letter-spacing: .18em; }
.allapot .halk { color: var(--halvany); }
.allapot .elmaradt { color: var(--riado); }

/* ---- próza ---- */
section { margin-bottom: 2.75rem; }
section > :first-child { margin-top: 0; }
h2 { font: 600 .72rem/1.8 var(--mono); letter-spacing: .2em; text-transform: uppercase;
  color: var(--vaz); margin: 0 0 .9rem; }
h3 { font: 600 .7rem/1.8 var(--mono); letter-spacing: .16em; text-transform: uppercase;
  color: var(--szoveg); margin: 2.2rem 0 .6rem; padding-top: 1rem;
  border-top: 1px solid var(--racs); }
section > h3:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
p { margin: .7rem 0; }
ul { margin: .7rem 0; padding-left: 1.15rem; }
li { margin: .25rem 0; }
li.task { list-style: none; margin-left: -1.15rem; }
li.task input { accent-color: var(--jel); margin-right: .45rem; }
code { font: .88em var(--mono); background: var(--lap); padding: .12em .35em; border-radius: .2rem; }
strong { font-weight: 600; }
.halk { color: var(--halvany); }

/* ---- mai csatornák ---- */
.csatornak { display: grid; gap: 1px; background: var(--racs); border: 1px solid var(--racs); }
.csatorna { display: flex; justify-content: space-between; align-items: baseline;
  gap: 1rem; padding: .75rem .9rem; background: var(--hatter); }
.csatorna .cimke { font: .72rem/1.4 var(--mono); letter-spacing: .1em;
  text-transform: uppercase; color: var(--halvany); }
.csatorna .ertek { font: 500 1rem/1.4 var(--mono); font-variant-numeric: tabular-nums; }
.csatorna.erkezett .ertek { color: var(--jel); }
/* Ami nincs mérve, annak nincs színe — és nem is mozdul. */
.csatorna.varakozik .ertek, .csatorna.elmaradt .ertek {
  color: var(--halvany); font-size: .8rem; font-weight: 400; }

/* ---- readout tábla ---- */
table { border-collapse: collapse; width: 100%; }
tr { border-bottom: 1px solid var(--racs); }
tr:last-child { border-bottom: 0; }
td { padding: .7rem 0; vertical-align: baseline; }
td:first-child { font: .78rem/1.4 var(--mono); color: var(--halvany); padding-right: 1rem; }
td.value { font: 500 1.05rem/1.4 var(--mono); font-variant-numeric: tabular-nums;
  text-align: right; white-space: nowrap; color: var(--jel); padding-right: 1rem; }
tr.dead td.value { color: var(--halvany); font-weight: 400; font-size: .82rem; }
td.ev { width: 9.5rem; }
.rail { display: block; height: 2px; background: var(--racs); position: relative; overflow: hidden; }
.rail::after { content: ""; position: absolute; inset: 0 auto 0 0; width: var(--fill, 0%);
  background: var(--jel); transform-origin: left center; }
.rail.dead { background: none; height: 0; border-top: 1px dashed var(--racs); }
.rail.dead::after { content: none; }
.note { display: block; margin-top: .4rem; font: .68rem/1.4 var(--mono); color: var(--halvany); }

/* ---- beszélgetés ---- */
.turn { margin: 1rem 0; padding-left: .9rem; border-left: 2px solid var(--racs); }
.turn.user { border-left-color: var(--jel-halk); }
.who { font: .66rem/1.8 var(--mono); letter-spacing: .18em; text-transform: uppercase;
  color: var(--halvany); }

/* ---- kérdés ---- */
form { display: flex; gap: .5rem; margin-top: 1.4rem; position: relative; }
form input[type=text] { flex: 1; padding: .7rem .8rem; background: var(--lap);
  border: 1px solid var(--racs); border-radius: .3rem; color: var(--szoveg); font: inherit; }
form input[type=text]::placeholder { color: var(--halvany); }
form input[type=text]:focus-visible { outline: 2px solid var(--jel); outline-offset: 1px; }
form button { padding: .7rem 1.15rem; border: 1px solid var(--jel); border-radius: .3rem;
  background: transparent; color: var(--jel); cursor: pointer;
  font: 600 .72rem/1.4 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
form button:hover:not([disabled]) { background: var(--jel-halk); }
form button:focus-visible { outline: 2px solid var(--jel); outline-offset: 2px; }
form [disabled] { opacity: .45; cursor: not-allowed; }
form.busy::after { content: ""; position: absolute; left: 0; right: 0; bottom: -.6rem; height: 2px;
  background: linear-gradient(90deg, transparent, var(--jel), transparent);
  background-size: 40% 100%; background-repeat: no-repeat;
  animation: sweep 1.1s linear infinite; }

/* ---- mozgás ---- */
@view-transition { navigation: auto; }
@keyframes settle { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes rail-in { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes sweep { from { background-position: -40% 0; } to { background-position: 140% 0; } }
.allapot, section { animation: settle .5s cubic-bezier(.2,.8,.2,1) both;
  animation-delay: calc(var(--i, 0) * 60ms); }
.rail::after { animation: rail-in .7s cubic-bezier(.2,.8,.2,1) both;
  animation-delay: calc(320ms + var(--i, 0) * 45ms); }
@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
  .allapot, section, .rail::after, form.busy::after { animation: none; }
}
`;
