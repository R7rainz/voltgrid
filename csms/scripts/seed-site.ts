import { db } from "../src/infrastructure/database/db";

try {
    const site = await db.orm.public.Site.select("id").first();

    if (!site) {
        await db.orm.public.Site.create({
            name: "VoltGrid Demo Site",
            powerLimitKw: 100,
            tariffPaisePerKwh: 800,
        });

        console.log("Created default VoltGrid demo site");
    } else {
        console.log(`Using existing VoltGrid site ${site.id}`);
    }
} finally {
    await db.close();
}
