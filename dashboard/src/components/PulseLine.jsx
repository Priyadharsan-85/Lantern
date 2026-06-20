import { useEffect, useRef } from 'react';

export default function PulseLine({ traces }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;

    const durations = traces && traces.length
      ? traces.slice(0, 40).map(t => Number(t.total_duration) || 20)
      : [20, 24, 18, 30, 22];

    const max = Math.max(...durations, 40);
    let frame = 0;
    let raf = null;

    const draw = () => {
      ctx.clearRect(0, 0, W, H);

      ctx.strokeStyle = '#2A2E37';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();

      ctx.strokeStyle = '#E8A23D';
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      const points = 120;
      for (let i = 0; i < points; i++) {
        const x = (i / points) * W;
        const idx = Math.floor((i + frame * 0.3) / points * durations.length) % durations.length;
        const val = durations[idx] || 20;
        const norm = val / max;
        const wobble = Math.sin(i * 0.4 + frame * 0.05) * 2;
        const y = H / 2 - norm * H * 0.32 - wobble;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      const lastX = W - W / points;
      ctx.beginPath();
      ctx.arc(lastX, H / 2 - (durations[0] / max) * H * 0.32, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#E8A23D';
      ctx.shadowColor = '#E8A23D';
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;

      frame++;
      raf = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [traces]);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />;
}