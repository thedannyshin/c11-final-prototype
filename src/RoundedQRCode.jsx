import QRCode from 'qrcode';
import { useMemo } from 'react';

/**
 * QR code with rounded dark modules (still scannable with modest rounding).
 */
export function RoundedQRCodeSVG({
  value,
  size = 140,
  fgColor = '#ffffff',
  level = 'L',
  moduleMargin = 0,
  /** Corner radius per module in 0–0.5 (fraction of one module unit). */
  cornerRadius = 0.38,
  title = 'QR code',
}) {
  const { dim, rects } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: level });
    const n = qr.modules.size;
    const margin = Math.floor(Math.max(0, moduleMargin));
    const dimInner = n + margin * 2;
    const rx = Math.min(Math.max(cornerRadius, 0), 0.48);
    const list = [];

    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (!qr.modules.get(row, col)) continue;
        const x = margin + col;
        const y = margin + row;
        list.push({ x, y, rx });
      }
    }

    return { dim: dimInner, rects: list };
  }, [value, level, moduleMargin, cornerRadius]);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      shapeRendering="geometricPrecision"
      role="img"
    >
      {title ? <title>{title}</title> : null}
      {rects.map(({ x, y, rx }) => (
        <rect key={`${y}-${x}`} x={x} y={y} width={1} height={1} rx={rx} ry={rx} fill={fgColor} />
      ))}
    </svg>
  );
}
