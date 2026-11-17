import "dotenv/config";
import { createFakeProviderApp } from "./app";
import { FaultRegistry, faultsFromEnv } from "./faults";

const port = Number(process.env.FAKES_PORT ?? 4000);
const faults = new FaultRegistry(faultsFromEnv(process.env));

createFakeProviderApp(faults).listen(port, () => {
  console.log(`Fake providers listening on http://localhost:${port}`);
  console.log("Initial faults:", JSON.stringify(faults.all()));
});
