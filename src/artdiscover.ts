export type DiscoveredNode = {
  udpSource: string;
  ip: string;
  artnetPort: number;
  shortName: string;
  longName: string;
  nodeReport: string;
  netSwitch: number;
  subSwitch: number;
  firmware: string;
  oemHex: string;
  estaCode: number;
  mac: string;
  bindIp: string;
  bindIndex: number;
  style: number;
  numPorts: number[];
  portTypesHex: string;
  swinHex: string;
  swoutHex: string;
};

export function parseDiscoverExtraIps(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
