"use client";

import { useMemo, useState } from "react";

const MIN_TOKENS = 1;
const MAX_TOKENS = 24;

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export default function AttentionLab() {
  const [tokenCount, setTokenCount] = useState(8);
  const [selectedToken, setSelectedToken] = useState<number | null>(null);
  const [isMoving, setIsMoving] = useState(true);
  const [showLabels, setShowLabels] = useState(true);

  const tokens = useMemo(() => Array.from({ length: tokenCount }, (_, index) => index + 1), [tokenCount]);
  const relations = tokenCount * tokenCount;
  const activeToken = selectedToken ?? 1;

  return (
    <main className="attention-app">
      <header className="attention-header">
        <a className="attention-brand" href="#top" aria-label="Attention Lab home">
          <span className="brand-orbit"><i /><i /><i /></span>
          <span>Attention Lab</span>
        </a>
        <div className="header-copy">
          <span className="header-kicker">TRANSFORMER INTUITION</span>
          <span>Every token can look at every other token.</span>
        </div>
        <div className="formula-pill" aria-label={`${tokenCount} tokens squared equals ${relations} attention relationships`}>
          <strong>N²</strong><span>attention relationships</span>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-title">
          <p className="eyebrow">THE QUADRATIC COST OF FULL ATTENTION</p>
          <h1>One more token doesn’t add <em>one</em> more connection.</h1>
          <p>It connects to the whole context. That is why the number of possible token-to-token relationships grows as <strong>N²</strong>.</p>
        </div>
        <div className="growth-readout" aria-live="polite">
          <span>LIVE RELATION COUNT</span>
          <strong>{formatNumber(relations)}</strong>
          <small>{tokenCount} × {tokenCount}</small>
        </div>
      </section>

      <section className="attention-stage" aria-label="Token attention visualization">
        <article className="token-field panel">
          <div className="panel-heading">
            <div><p className="eyebrow">01 · TOKENS IN THE CONTEXT WINDOW</p><h2>{tokenCount} tokens</h2></div>
            <span className="panel-note">each dot = one token</span>
          </div>
          <div className={`token-vessel ${isMoving ? "is-moving" : ""}`}>
            <div className="vessel-grid" />
            <div className="vessel-glow" />
            {tokens.map((token, index) => {
              const angle = (index / tokenCount) * 360 - 90;
              const radius = tokenCount === 1 ? 0 : 24 + (index % 3) * 10;
              const x = 50 + Math.cos(angle * Math.PI / 180) * radius;
              const y = 50 + Math.sin(angle * Math.PI / 180) * radius;
              const isActive = token === activeToken;
              return <button
                className={`context-token ${isActive ? "is-active" : ""}`}
                key={token}
                style={{ "--x": `${x}%`, "--y": `${y}%`, "--delay": `${index * -0.38}s` } as React.CSSProperties}
                onMouseEnter={() => setSelectedToken(token)}
                onFocus={() => setSelectedToken(token)}
                onClick={() => setSelectedToken(token)}
                aria-label={`Token ${token}. ${isActive ? "Highlighted" : "Highlight this token"}`}
              >
                <i />
                {showLabels && <b>{token}</b>}
              </button>;
            })}
            <div className="focus-message"><span>FOCUS</span><strong>token {activeToken}</strong><small>can attend to all {tokenCount} tokens</small></div>
          </div>
          <div className="token-key"><span><i className="key-dot active" /> selected token</span><span><i className="key-dot" /> context token</span><span>Hover or tap any dot</span></div>
        </article>

        <article className="matrix-panel panel">
          <div className="panel-heading">
            <div><p className="eyebrow">02 · PAIRWISE ATTENTION MATRIX</p><h2>{tokenCount}² relationships</h2></div>
            <span className="matrix-note"><i /> one possible attention score</span>
          </div>
          <div className="matrix-wrap">
            <div className="matrix-axis matrix-axis-top" aria-hidden="true">{tokens.map(token => <span key={token}>{showLabels ? token : ""}</span>)}</div>
            <div className="matrix-axis matrix-axis-left" aria-hidden="true">{tokens.map(token => <span key={token}>{showLabels ? token : ""}</span>)}</div>
            <div className="attention-matrix" style={{ "--matrix-size": tokenCount } as React.CSSProperties} role="grid" aria-label={`${tokenCount} by ${tokenCount} attention matrix`}>
              {tokens.flatMap(row => tokens.map(column => {
                const isFocus = row === activeToken || column === activeToken;
                const isSelf = row === column;
                return <button
                  key={`${row}-${column}`}
                  className={`relation ${isFocus ? "is-focus" : ""} ${isSelf ? "is-self" : ""}`}
                  onMouseEnter={() => setSelectedToken(row)}
                  onFocus={() => setSelectedToken(row)}
                  onClick={() => setSelectedToken(row)}
                  aria-label={`Attention from token ${row} to token ${column}`}
                  role="gridcell"
                ><i /></button>;
              }))}
            </div>
            <div className="axis-label top-label">KEYS / CONTEXT TOKENS →</div>
            <div className="axis-label left-label">QUERIES →</div>
          </div>
          <p className="matrix-caption"><strong>{formatNumber(relations)} little dots</strong> appear because every one of the {tokenCount} query tokens can assign attention to every one of the {tokenCount} context tokens.</p>
        </article>
      </section>

      <section className="explainer-strip">
        <span className="step-label">WHY IT SCALES THIS WAY</span>
        <div><b>{tokenCount}</b><span>query tokens</span></div><i>×</i><div><b>{tokenCount}</b><span>context tokens</span></div><i>=</i><div className="answer"><b>{formatNumber(relations)}</b><span>attention scores</span></div>
        <p>Doubling N makes this work roughly <strong>four times larger.</strong></p>
      </section>

      <section className="control-deck" aria-label="Visualization controls">
        <div className="control-copy"><p className="eyebrow">CHANGE THE CONTEXT LENGTH</p><strong><output>{tokenCount}</output> tokens</strong><span> → <output>{formatNumber(relations)}</output> relationships</span></div>
        <div className="slider-control">
          <div className="slider-labels"><span>1 token</span><span>24 tokens</span></div>
          <input type="range" min={MIN_TOKENS} max={MAX_TOKENS} value={tokenCount} onChange={(event) => { setTokenCount(Number(event.target.value)); setSelectedToken(null); }} aria-label="Number of tokens" />
        </div>
        <div className="control-actions">
          <button className={isMoving ? "selected" : ""} onClick={() => setIsMoving(!isMoving)} aria-pressed={isMoving}>{isMoving ? "Pause motion" : "Animate dots"}</button>
          <button className={showLabels ? "selected" : ""} onClick={() => setShowLabels(!showLabels)} aria-pressed={showLabels}>{showLabels ? "Hide labels" : "Show labels"}</button>
        </div>
      </section>
      <footer>Full self-attention is powerful because every token has global context. It is expensive because all pairs must be considered.</footer>
    </main>
  );
}
