import module0 from "./84f8bb40a74bd8f5.wasm";
import bytes0 from "./84f8bb40a74bd8f5.bin";
import module1 from "./89a6e459d9c62536.wasm";
import bytes1 from "./89a6e459d9c62536.bin";
import module2 from "./8df464263c87e487.wasm";
import bytes2 from "./8df464263c87e487.bin";
import module3 from "./ee31352216f0559b.wasm";
import bytes3 from "./ee31352216f0559b.bin";

export const PRECOMPILED: { bytes: Uint8Array; module: WebAssembly.Module }[] = [
  { bytes: new Uint8Array(bytes0), module: module0 },
  { bytes: new Uint8Array(bytes1), module: module1 },
  { bytes: new Uint8Array(bytes2), module: module2 },
  { bytes: new Uint8Array(bytes3), module: module3 },
];
