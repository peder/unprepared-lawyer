// Verifies a real TypeSafe key end to end: one noul + one choice through
// HttpJevClient, printed normalized. Never logs the key.
//   $env:TYPESAFE_API_KEY="..." ; npx tsx scripts/jev-ping.ts
import "./env.js";
import { HttpJevClient } from "../server/jev/JevClient.js";

async function main() {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("Set TYPESAFE_API_KEY first (PowerShell: $env:TYPESAFE_API_KEY=\"...\" ).");
    process.exit(1);
  }
  const jev = new HttpJevClient();
  const res = await jev.request({
    model: process.env.JEV_MODEL ?? "jev-latest",
    state: { charge: "Grand theft of a prize pumpkin.", current_question: "Did the goose look guilty?" },
    questions: {
      guilty: { type: "noul", instructions: "Given state.current_question and the charge, does the juror believe the defendant is guilty?" },
      reaction: {
        type: "choice",
        instructions: "How does the juror visibly react?",
        criteria: { unmoved: "unmoved", amused: "amused", shocked: "shocked" },
      },
    },
  });
  console.log("model:", res.model);
  console.log(JSON.stringify(res.answers, null, 1));
}

main().catch((e) => {
  console.error("ping failed:", (e as Error).message);
  process.exit(1);
});
