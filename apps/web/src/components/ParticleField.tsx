'use client';

import { useEffect, useRef } from 'react';

const PARTICLE_COLORS = ['#ff2f7e', '#7c5cfc', '#2f8aff', '#ffc53d', '#34d399'];

/**
 * Real, reported feedback ("still no movement at all... more immersive", citing a site built on
 * a drifting star/particle field): the earlier rounds' blurred colour blobs read as a soft, slow
 * wash — genuinely alive, but not the "floating through something" depth a particle field gives.
 * This is that field, built plain (a single `<canvas>`, no charting/animation library — nothing
 * else in this codebase pulls one in either) rather than dozens of separate DOM nodes: a fixed
 * set of small soft dots in the confetti brand palette, each drifting on its own slow, gentle
 * heading and wrapping back around when it drifts off an edge, so the field never thins out or
 * needs restarting.
 *
 * `prefers-reduced-motion: reduce` renders exactly one still frame (real particles, just frozen)
 * and never starts the loop — texture without motion, not an empty canvas. Cleans up its own
 * animation frame and resize listener on unmount.
 */
export function ParticleField({ count = 46 }: { count?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let width = 0;
    let height = 0;
    function resize() {
      const parent = canvas!.parentElement;
      width = parent ? parent.clientWidth : window.innerWidth;
      height = parent ? parent.clientHeight : window.innerHeight;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    const particles = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 1.2 + Math.random() * 2.4,
      vx: (Math.random() - 0.5) * 0.12,
      vy: (Math.random() - 0.5) * 0.12,
      color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
      alpha: 0.25 + Math.random() * 0.35,
      // Each dot's own gentle brightness pulse — a plain sine, phase-offset per particle so the
      // whole field twinkles asynchronously rather than in one unison pulse.
      pulsePhase: Math.random() * Math.PI * 2,
    }));

    function draw(t: number) {
      ctx!.clearRect(0, 0, width, height);
      for (const p of particles) {
        if (!reduceMotion) {
          p.x += p.vx;
          p.y += p.vy;
          if (p.x < -8) p.x = width + 8;
          if (p.x > width + 8) p.x = -8;
          if (p.y < -8) p.y = height + 8;
          if (p.y > height + 8) p.y = -8;
        }
        const twinkle = reduceMotion ? 1 : 0.65 + 0.35 * Math.sin(t / 1400 + p.pulsePhase);
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx!.fillStyle = p.color;
        ctx!.globalAlpha = p.alpha * twinkle;
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;
    }

    if (reduceMotion) {
      draw(0);
      return () => window.removeEventListener('resize', resize);
    }

    let raf = requestAnimationFrame(function loop(t) {
      draw(t);
      raf = requestAnimationFrame(loop);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [count]);

  return <canvas aria-hidden ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
}
