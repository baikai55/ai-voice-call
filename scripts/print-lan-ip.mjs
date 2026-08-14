import { networkInterfaces } from "node:os";
const port = process.env.PORT || "8787";
const host = process.env.HOST || "127.0.0.1";
const nets = networkInterfaces();
const ips = [];
for (const name of Object.keys(nets)) {
  for (const net of nets[name] || []) {
    const family = String(net.family);
    if ((family === "IPv4" || family === "4") && !net.internal) {
      ips.push({ name, address: net.address });
    }
  }
}
console.log(`PC local: http://127.0.0.1:${port}`);
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.log("LAN HTTP (HOST is explicitly enabled):");
  if (!ips.length) console.log("- No LAN IPv4 found");
  for (const item of ips) console.log(`- ${item.name}: http://${item.address}:${port}`);
}
console.log("Phone microphone: use the deployed Cloudflare HTTPS address.");
