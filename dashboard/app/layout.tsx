import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
    title: "VoltGrid Simulation Lab",
    description: "Control-room dashboard for simulated EV chargers",
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
