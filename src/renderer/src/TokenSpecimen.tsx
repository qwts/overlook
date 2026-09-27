import type { CSSProperties, ReactElement } from 'react';

// Token specimen surface (#54 exit criteria): renders neutrals, accents +
// dims, and the type scale straight from the CSS custom properties so drift
// from the design tokens is visible at a glance. Storybook stories (#56)
// take over as the canonical specimen; this page keeps the shell verifiable
// until then.

const NEUTRALS = ['--gray-0', '--gray-1', '--gray-2', '--gray-3', '--gray-4'];
const ACCENTS = ['--accent-iris', '--accent-amber', '--accent-green', '--accent-red'];
const TYPE_SIZES = ['--text-xs', '--text-sm', '--text-md', '--text-lg', '--text-xl', '--text-display'];

const sectionStyle: CSSProperties = { marginTop: 'var(--space-7)' };
const rowStyle: CSSProperties = { display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-3)' };

function Swatch({ token, background }: { token: string; background: string }): ReactElement {
  return (
    <div>
      <div
        style={{
          width: 72,
          height: 40,
          background,
          borderRadius: 'var(--radius-1)',
          border: '1px solid var(--border-1)',
        }}
      />
      <div className="mono-data" style={{ color: 'var(--text-faint)', marginTop: 'var(--space-1)' }}>
        {token}
      </div>
    </div>
  );
}

export function TokenSpecimen(): ReactElement {
  return (
    <div style={{ padding: 'var(--space-8)', overflowX: 'hidden', overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <p style={{ margin: 0 }}>Overlook — shell placeholder</p>

      <section style={sectionStyle}>
        <div className="mono-data" style={{ color: 'var(--text-muted)' }}>
          Neutrals
        </div>
        <div style={rowStyle}>
          {NEUTRALS.map((token) => (
            <Swatch key={token} token={token} background={`var(${token})`} />
          ))}
        </div>
      </section>

      <section style={sectionStyle}>
        <div className="mono-data" style={{ color: 'var(--text-muted)' }}>
          Accents · dims
        </div>
        <div style={rowStyle}>
          {ACCENTS.map((token) => (
            <Swatch key={token} token={token} background={`var(${token})`} />
          ))}
        </div>
        <div style={rowStyle}>
          {ACCENTS.map((token) => (
            <Swatch key={`${token}-dim`} token={`${token}-dim`} background={`var(${token}-dim)`} />
          ))}
        </div>
      </section>

      <section style={sectionStyle}>
        <div className="mono-data" style={{ color: 'var(--text-muted)' }}>
          Type scale
        </div>
        {TYPE_SIZES.map((token) => (
          <div key={token} style={{ fontSize: `var(${token})`, marginTop: 'var(--space-2)' }}>
            Photos stay yours — {token}
          </div>
        ))}
        <div className="mono-data" style={{ marginTop: 'var(--space-3)', color: 'var(--text-muted)' }}>
          26.1 MP · 6240×4160 · 54.2 MB
        </div>
      </section>
    </div>
  );
}
