import { Globe, Laptop, Smartphone, Tablet, Tv } from 'lucide-react';
import type { Device } from '@tuna/shared';

const ICONS: Record<Device['kind'], typeof Laptop> = { phone: Smartphone, tablet: Tablet, computer: Laptop, tv: Tv, browser: Globe };
export const DeviceIcon = ({ kind, size = 18 }: { kind: Device['kind']; size?: number }) => {
  const Icon = ICONS[kind] ?? Globe;
  return <Icon size={size} />;
};
