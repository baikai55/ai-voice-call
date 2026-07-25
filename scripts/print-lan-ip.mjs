import { networkInterfaces } from "node:os";
const port = process.env.PORT || "8787";
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
console.log("Open on your phone (same WiFi):");
if (!ips.length) console.log("- No LAN IPv4 found");
for (const item of ips) console.log(`- ${item.name}: http://${item.address}:${port}`);
console.log("");
console.log(`PC local: http://127.0.0.1:${port}`);
console.log("Note: text chat works over LAN HTTP; microphone may need HTTPS on some phones.");

// hint for phone mic
try {
  const { networkInterfaces } = await import("node:os");
  const nets = networkInterfaces();
  console.log("Phone mic (HTTPS):");
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n && (n.family === "IPv4" || n.family === 4) && !n.internal) {
        console.log("  https://" + n.address + ":8788");
      }
    }
  }
} catch {}
