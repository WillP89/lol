'use client';

import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import { categoryStyle } from '@/lib/categoryStyle';
import { formatPriceFrom } from '@/lib/formatPrice';

export interface ExploreExperience {
  id: string;
  name: string;
  description: string;
  category: string;
  subcategories?: unknown;
  startsAt: string;
  priceMinMinor: number | null;
  priceMaxMinor?: number | null;
  currency: string;
  imageUrl?: string | null;
  venue: { name: string; latitude: number; longitude: number };
}

// Leaflet's default marker icon resolves to image paths that bundlers (Next/webpack) don't
// serve correctly out of the box — the classic "broken marker" bug. A DivIcon sidesteps that
// entirely: no external image asset, just CSS, and it matches the gold-dot pin styling from
// the founding-team demo.
const pinIcon = L.divIcon({
  className: '',
  html: '<span style="display:block;width:14px;height:14px;border-radius:50%;background:#F2A93B;box-shadow:0 0 0 4px rgba(242,169,59,.28);border:2px solid #100F17;"></span>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

export default function ExploreMap({
  experiences,
  center,
  onSelect,
}: {
  experiences: ExploreExperience[];
  center: [number, number];
  // Opens the full event-detail sheet — tapping a pin should let you read about the event
  // before committing to sending it anywhere, same as tapping a card in List view.
  onSelect: (exp: ExploreExperience) => void;
}) {
  return (
    <MapContainer center={center} zoom={12} scrollWheelZoom style={{ height: '100%', width: '100%', borderRadius: 18 }}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {experiences.map((exp) => {
        const style = categoryStyle(exp.category);
        return (
          <Marker key={exp.id} position={[exp.venue.latitude, exp.venue.longitude]} icon={pinIcon}>
            <Popup minWidth={210}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 18, lineHeight: 1 }}>{style.emoji}</span>
                <strong style={{ fontFamily: 'Fraunces, serif', fontSize: 14.5 }}>{exp.name}</strong>
              </div>
              <div style={{ fontSize: 12.5, color: '#555', lineHeight: 1.6 }}>
                {exp.venue.name}
                <br />
                {new Date(exp.startsAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                {formatPriceFrom(exp.priceMinMinor, exp.currency) && ` · ${formatPriceFrom(exp.priceMinMinor, exp.currency)}`}
              </div>
              <button
                onClick={() => onSelect(exp)}
                style={{
                  marginTop: 10,
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'var(--ink-gold)',
                  color: 'var(--ink-gold-ink)',
                  fontWeight: 700,
                  fontSize: 12.5,
                  cursor: 'pointer',
                }}
              >
                View details →
              </button>
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
