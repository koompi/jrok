
import { connectDatabase, getCollections, closeDatabase } from "../src/utils/mongodb";

async function main() {
    const domain = "nginxxrlgw3-qefy";
    console.log(`Starting cleanup for domain: ${domain}`);

    try {
        await connectDatabase();
        const collections = getCollections();

        // Check tunnel
        const tunnel = await collections.tunnels.findOne({ domain });
        if (tunnel) {
            console.log(`Found stale tunnel:`, tunnel);
            await collections.tunnels.deleteOne({ domain });
            console.log(`✅ Deleted stale tunnel for ${domain}`);
        } else {
            console.log(`No tunnel found for ${domain}`);
        }

        // Check agent connection
        const conn = await collections.agentConnections.findOne({ domain });
        if (conn) {
            console.log(`Found active agent connection:`, conn);
            await collections.agentConnections.deleteOne({ domain });
            console.log(`✅ Deleted agent connection for ${domain}`);
        } else {
            console.log(`No active agent connection found for ${domain}`);
        }

    } catch (error) {
        console.error("Error during cleanup:", error);
    } finally {
        await closeDatabase();
    }
}

main();
