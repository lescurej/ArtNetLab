import fs from "node:fs";

const configPath = "src-tauri/tauri.conf.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

config.bundle = config.bundle ?? {};
config.bundle.macOS = config.bundle.macOS ?? {};

const sign = process.env.ENABLE_MACOS_SIGN === "1";
const identity = (process.env.MACOS_SIGNING_IDENTITY ?? "").trim();

if (sign && identity) {
  config.bundle.macOS.signingIdentity = identity;
  config.bundle.macOS.hardenedRuntime = true;
} else {
  delete config.bundle.macOS.signingIdentity;
  config.bundle.macOS.hardenedRuntime = false;
}

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
