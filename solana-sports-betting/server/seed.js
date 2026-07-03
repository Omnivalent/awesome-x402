// Seed a couple of sample markets so the UI isn't empty on first run.
//   node server/seed.js
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "./store.js";
import { solToLamports } from "./pari.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = process.env.DATA_PATH || join(__dirname, "..", "data", "store.json");

const store = new Store(DATA_PATH);

const samples = [
  {
    title: "World Cup Final: Brazil vs Argentina",
    category: "Football",
    description: "Who lifts the trophy? Each slot is 1 SOL. Winners split the whole pot.",
    outcomes: [
      { id: "brazil", label: "Brazil win" },
      { id: "argentina", label: "Argentina win" },
      { id: "draw", label: "Draw (decided on penalties counts as draw)" },
    ],
    slotPriceLamports: solToLamports(1),
    entryFeeBps: 250,
    cashoutFeeBps: 500,
    rakeBps: 0,
  },
  {
    title: "NBA Tonight: Lakers vs Celtics",
    category: "Basketball",
    description: "Pick the winner. Slot price 0.5 SOL.",
    outcomes: [
      { id: "lakers", label: "Lakers" },
      { id: "celtics", label: "Celtics" },
    ],
    slotPriceLamports: solToLamports(0.5),
    entryFeeBps: 250,
    cashoutFeeBps: 500,
    rakeBps: 100,
  },
];

for (const s of samples) {
  const m = store.createMarket(s);
  console.log(`seeded: ${m.id}  ${m.title}`);
}
console.log(`\nStore written to ${DATA_PATH}`);
