'use client';

import { useEffect, useRef } from 'react';

const PARTICLE_COLORS = ['#ff2f7e', '#7c5cfc', '#2f8aff', '#ffc53d', '#34d399'];

/**
 * Real, reported feedback across two rounds now — first "still no movement at all... more
 * immersive", then (after the first particle field + parallax pass) "you have to look for it, I
 * want it in your face this time". This round is a deliberate overcorrection from "ambient
 * texture" to "unmissable, always moving even before you touch anything": far more particles,
 * bigger, brighter, drifting noticeably faster, AND — the actual "in your face" difference — each
 * one now draws a live connecting line to its nearby neighbours (the classic constellation/network
 * effect), so the field reads as one connected, visibly shifting web rather than a scatter of
 * static-feeling dots. Still a single `<canvas>`, no charting/animation library.
 *
 * `prefers-reduced-motion: reduce` renders exactly one still frame (real particles and their real
 * connecting lines, just frozen) and never starts the loop. Cleans up its own animation frame and
 * resize listener on unmount.
 */
export function ParticleField({ count = 90 }: { count?: number }) {
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

    // Real correction after a first attempt at this: a link radius that grew with particle count
    // (more particles -> a LARGER radius) turned the whole screen into a dense, headline-
    // obscuring mesh — the opposite of legible "in your face" motion. Fixed, modest radius
    // instead — only genuinely nearby particles ever connect, so more particles means more small
    // local clusters drifting around, never one screen-spanning web.
    const linkRadius = 110;
    const particles = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 1.8 + Math.random() * 3.2,
      vx: (Math.random() - 0.5) * 0.6,
      vy: (Math.random() - 0.5) * 0.6,
      color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
      alpha: 0.45 + Math.random() * 0.4,
      pulsePhase: Math.random() * Math.PI * 2,
    }));

    function draw(t: number) {
      ctx!.clearRect(0, 0, width, height);

      if (!reduceMotion) {
        for (const p of particles) {
          p.x += p.vx;
          p.y += p.vy;
          if (p.x < -8) p.x = width + 8;
          if (p.x > width + 8) p.x = -8;
          if (p.y < -8) p.y = height + 8;
          if (p.y > height + 8) p.y = -8;
        }
      }

      // The connecting web — drawn first so the dots sit on top. Distance-faded: a line between
      // two particles right next to each other is nearly opaque, fading to invisible right at
      // `linkRadius`, never a hard cutoff edge.
      ctx!.lineWidth = 1;
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i];
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < linkRadius) {
            ctx!.beginPath();
            ctx!.moveTo(a.x, a.y);
            ctx!.lineTo(b.x, b.y);
            ctx!.strokeStyle = a.color;
            ctx!.globalAlpha = (1 - dist / linkRadius) * 0.22;
            ctx!.stroke();
          }
        }
      }

      for (const p of particles) {
        const twinkle = reduceMotion ? 1 : 0.7 + 0.3 * Math.sin(t / 900 + p.pulsePhase);
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
