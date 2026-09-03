'use client';

import { useEffect } from 'react';
import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';

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
  // Real bug this fixes: "the event details... should be available... so they can see what the
  // cost and details are" — some providers (Skiddle in particular) genuinely don't give us a
  // structured price for every listing (see providers/live/skiddle.ts#parseEntryPrice's own
  // honest-null comment). `externalUrl` itself lives on the related ProviderListing, not on
  // Experience (see schema.prisma) — services/explore.ts now includes it as `listings`, same
  // shape the Plan detail page already exposes for the identical "see the real source" job. Lets
  // the detail sheet point someone at the source listing for whatever Plot's own normalized
  // fields don't carry, instead of silently having no price line at all.
  listings?: { externalUrl: string }[];
  venue: { name: string; latitude: number; longitude: number };
}

// A DivIcon, not Leaflet's default marker image (which doesn't bundle correctly under
// Next/webpack out of the box) — plain CSS, no external asset. The selected marker gets a
// visibly larger, brighter treatment so map <-> card selection reads as one system, not two
// independent widgets sitting next to each other.
function pinIcon(selected: boolean) {
  const size = selected ? 22 : 14;
  return L.divIcon({
    className: '',
    html: selected
      ? `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;background:#FFAB2E;box-shadow:0 0 0 6px rgba(255,171,46,.32),0 2px 10px rgba(0,0,0,.5);border:2.5px solid #0F0A06;"></span>`
      : `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;background:#FFAB2E;box-shadow:0 0 0 4px rgba(255,171,46,.24);border:2px solid #0F0A06;"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/** Selecting an event (from a marker tap or a card tap) pans the map to it — a real card <->
 * marker relationship, not two independently-scrolling widgets. Has to live inside
 * `<MapContainer>` to reach `useMap()`. */
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

export default function ExploreMap({
  experiences,
  center,
  selectedId,
  onMarkerClick,
}: {
  experiences: ExploreExperience[];
  center: [number, number];
  selectedId?: string | null;
  // A marker tap selects (previews) the event — it does NOT jump straight to the detail sheet;
  // that's what tapping the corresponding card does. Same relationship a real map product uses.
  onMarkerClick: (exp: ExploreExperience) => void;
}) {
  return (
    <MapContainer center={center} zoom={12} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
      {/* CARTO's basemap CDN now requires an API key we don't have — without one every tile
          renders as a bare "API KEY REQUIRED" placeholder (confirmed via a live screenshot on
          ExploreMapV2, the component actually rendered in the app; this file is currently dead
          code, but fixed too rather than left as a trap for whoever next wires it back in). */}
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        subdomains="abc"
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
