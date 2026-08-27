const express = require("express");
const rateLimit = require("express-rate-limit");

const app = express();

const PORT = process.env.PORT || 3000;

const XUI_BASE_URL = (
    process.env.XUI_BASE_URL ||
    ""
).replace(/\/+$/, "");

const XUI_API_TOKEN = process.env.XUI_API_TOKEN || "";

if (!XUI_BASE_URL || !XUI_API_TOKEN) {
    console.error("Missing XUI_BASE_URL or XUI_API_TOKEN");
    process.exit(1);
}

app.use(express.json({ limit: "100kb" }));

app.use(
    express.static("public", {
        extensions: ["html"]
    })
);

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        msg: "Too many requests. Try again later."
    }
});

app.use("/api", apiLimiter);


/* -----------------------------------------
   3x-ui request helper
----------------------------------------- */

async function xuiRequest(path, options = {}) {

    const response = await fetch(
        `${XUI_BASE_URL}${path}`,
        {
            ...options,
            headers: {
                "Authorization": `Bearer ${XUI_API_TOKEN}`,
                "Content-Type": "application/json",
                ...(options.headers || {})
            }
        }
    );

    const text = await response.text();

    let data;

    try {
        data = JSON.parse(text);
    } catch {
        data = {
            success: response.ok,
            raw: text
        };
    }

    if (!response.ok) {
        throw new Error(
            data.msg ||
            data.message ||
            `3x-ui returned HTTP ${response.status}`
        );
    }

    return data;
}


/* -----------------------------------------
   Health check
----------------------------------------- */

app.get("/api/health", async (req, res) => {

    res.json({
        success: true,
        service: "VLESS Subscription Panel",
        xui: true
    });

});


/* -----------------------------------------
   Get VLESS inbounds
----------------------------------------- */

app.get("/api/inbounds", async (req, res) => {

    try {

        const result = await xuiRequest(
            "/panel/api/inbounds/list"
        );

        const inbounds = Array.isArray(result.obj)
            ? result.obj
            : [];

        const vless = inbounds
            .filter(inbound => {

                const protocol =
                    String(inbound.protocol || "")
                        .toLowerCase();

                return protocol === "vless";

            })
            .map(inbound => {

                return {
                    id: inbound.id,
                    remark: inbound.remark || `Inbound ${inbound.id}`,
                    port: inbound.port,
                    protocol: inbound.protocol,
                    enable: inbound.enable !== false
                };

            });

        res.json({
            success: true,
            obj: vless
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            msg: error.message
        });

    }

});


/* -----------------------------------------
   Get clients
----------------------------------------- */

app.get("/api/clients", async (req, res) => {

    try {

        const result = await xuiRequest(
            "/panel/api/clients/list"
        );

        const clients = Array.isArray(result.obj)
            ? result.obj
            : [];

        const cleanClients = clients.map(client => {

            return {
                email: client.email || "",
                subId: client.subId || "",
                enable: client.enable !== false,
                totalGB: client.totalGB || 0,
                expiryTime: client.expiryTime || 0,
                inboundIds: client.inboundIds || [],
                comment: client.comment || ""
            };

        });

        res.json({
            success: true,
            obj: cleanClients
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            msg: error.message
        });

    }

});


/* -----------------------------------------
   Create VLESS client
----------------------------------------- */

app.post("/api/clients", async (req, res) => {

    try {

        const {
            email,
            inboundIds,
            totalGB,
            expiryTime,
            comment
        } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                msg: "Email is required."
            });
        }

        if (
            !Array.isArray(inboundIds) ||
            inboundIds.length === 0
        ) {
            return res.status(400).json({
                success: false,
                msg: "At least one VLESS inbound is required."
            });
        }

        const vlessInboundsResult =
            await xuiRequest(
                "/panel/api/inbounds/list"
            );

        const vlessIds =
            (vlessInboundsResult.obj || [])
                .filter(x =>
                    String(x.protocol || "")
                        .toLowerCase() === "vless"
                )
                .map(x => Number(x.id));

        const invalidInbound =
            inboundIds.some(
                id => !vlessIds.includes(Number(id))
            );

        if (invalidInbound) {
            return res.status(400).json({
                success: false,
                msg: "Only VLESS inbound IDs are allowed."
            });
        }

        const client = {
            email: String(email).trim(),
            totalGB: Number(totalGB || 0),
            expiryTime: Number(expiryTime || 0),
            tgId: 0,
            limitIp: 0,
            enable: true,
            comment: String(comment || "").trim()
        };

        const result = await xuiRequest(
            "/panel/api/clients/add",
            {
                method: "POST",
                body: JSON.stringify({
                    client,
                    inboundIds:
                        inboundIds.map(Number)
                })
            }
        );

        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            msg: error.message
        });

    }

});


/* -----------------------------------------
   Generate VLESS subscription
----------------------------------------- */

app.get("/api/sub/:subId", async (req, res) => {

    try {

        const subId =
            String(req.params.subId || "")
                .trim();

        if (!subId) {
            return res.status(400).send(
                "Missing subscription ID"
            );
        }

        if (!/^[a-zA-Z0-9_-]+$/.test(subId)) {
            return res.status(400).send(
                "Invalid subscription ID"
            );
        }

        const result = await xuiRequest(
            `/panel/api/clients/subLinks/${encodeURIComponent(subId)}`
        );

        const links = Array.isArray(result.obj)
            ? result.obj
            : [];

        const vlessLinks = links.filter(link =>
            typeof link === "string" &&
            link.toLowerCase().startsWith("vless://")
        );

        if (vlessLinks.length === 0) {
            return res.status(404).send(
                "No VLESS configuration found"
            );
        }

        /*
         * Standard subscription format:
         * Base64 encoded list of proxy URLs.
         */

        const subscription =
            Buffer
                .from(vlessLinks.join("\n"), "utf8")
                .toString("base64");

        res.setHeader(
            "Content-Type",
            "text/plain; charset=utf-8"
        );

        res.setHeader(
            "Cache-Control",
            "no-store"
        );

        res.send(subscription);

    } catch (error) {

        console.error(error);

        res.status(500).send(
            "Subscription generation failed"
        );

    }

});


/* -----------------------------------------
   JSON VLESS links - useful for debugging
----------------------------------------- */

app.get("/api/sub/:subId/json", async (req, res) => {

    try {

        const subId =
            String(req.params.subId || "").trim();

        const result = await xuiRequest(
            `/panel/api/clients/subLinks/${encodeURIComponent(subId)}`
        );

        const links = Array.isArray(result.obj)
            ? result.obj.filter(link =>
                typeof link === "string" &&
                link.startsWith("vless://")
            )
            : [];

        res.json({
            success: true,
            count: links.length,
            links
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            msg: error.message
        });

    }

});


/* -----------------------------------------
   Frontend fallback
----------------------------------------- */

app.get("*", (req, res) => {

    res.sendFile(
        require("path").join(
            __dirname,
            "public",
            "index.html"
        )
    );

});


app.listen(PORT, "0.0.0.0", () => {

    console.log(
        `VLESS Subscription Panel running on port ${PORT}`
    );

});
