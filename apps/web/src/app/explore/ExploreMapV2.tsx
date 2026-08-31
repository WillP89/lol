'use client';

import { useEffect } from 'react';
import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { ExploreExperience } from './ExploreMap';

// V2's map language: a light basemap (CARTO Positron) to match the new paper-bright system —
// the old dark CARTO tiles belonged to the banned dark UI. Coral pins, not gold — the new
// brand colour, not the old one.
function pinIcon(selected: boolean) {
  const size = selected ? 26 : 16;
  return L.divIcon({
    className: '',
    html: selected
      ? `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;background:#ff3d5a;box-shadow:0 0 0 7px rgba(255,61,90,.22),0 4px 14px rgba(26,21,16,.35);border:3px solid #fff;"></span>`
      : `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;background:#ff3d5a;box-shadow:0 2px 8px rgba(26,21,16,.25);border:2.5px solid #fff;"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function FlyToSelected({ experiences, selectedId }: { experiences: ExploreExperience[]; selectedId?: string | null }) {
  const map = useMap();
  useEffect(() => {
    if (!selectedId) return;
    const exp = experiences.find((e) => e.id === selectedId);
    if (!exp) return;
    map.flyTo([exp.venue.latitude, exp.venue.longitude], Math.max(map.getZoom(), 13), { duration: 0.6 });
  }, [selectedId]);
  return null;
}

export default function ExploreMapV2({
  experiences,
  center,
  selectedId,
  onMarkerClick,
}: {
  experiences: ExploreExperience[];
  center: [number, number];
  selectedId?: string | null;
  onMarkerClick: (exp: ExploreExperience) => void;
}) {
  return (
    <MapContainer center={center} zoom={12} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        subdomains="abcd"
        maxZoom={19}
      />
      <FlyToSelected experiences={experiences} selectedId={selectedId} />
      {experiences.map((exp) => (
        <Marker
          key={exp.id}
          position={[exp.venue.latitude, exp.venue.longitude]}
          icon={pinIcon(exp.id === selectedId)}
          eventHandlers={{ click: () => onMarkerClick(exp) }}
        />
      ))}
    </MapContainer>
  );
}
