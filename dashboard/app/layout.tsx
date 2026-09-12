import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
    title: "VoltGrid | Site Control Room",
    description: "Live control-room dashboard for simulated EV charging sessions",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
