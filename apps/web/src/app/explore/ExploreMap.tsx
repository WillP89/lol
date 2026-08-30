'use client';

import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';

export interface ExploreExperience {
  id: string;
  name: string;
  category: string;
  startsAt: string;
  priceMinMinor: number | null;
  currency: string;
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

export default function ExploreMap({ experiences, center }: { experiences: ExploreExperience[]; center: [number, number] }) {
  return (
    <MapContainer center={center} zoom={12} scrollWheelZoom style={{ height: '100%', width: '100%', borderRadius: 18 }}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {experiences.map((exp) => (
        <Marker key={exp.id} position={[exp.venue.latitude, exp.venue.longitude]} icon={pinIcon}>
          <Popup>
            <strong>{exp.name}</strong>
            <br />
            {exp.venue.name}
            <br />
            {new Date(exp.startsAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            {exp.priceMinMinor !== null && (
              <>
                <br />
                from £{(exp.priceMinMinor / 100).toFixed(0)}
              </>
            )}
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
