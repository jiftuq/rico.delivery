# RICO — Full-Stack P2P Delivery Platform

React + Convex + Leaflet + RICO Token

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up Convex
npx convex dev
# This creates your Convex project and generates _generated/ files
# It also creates .env.local with your VITE_CONVEX_URL automatically

# 3. Start the app (in a new terminal)
npm run dev:frontend

# Open http://localhost:5173
```

## What Happens on First Visit

1. Browser auto-generates a wallet address
2. Convex `users.getOrCreate` creates the user with 50 RICO airdrop
3. GPS location is requested
4. User sees live tasks and can post/bid immediately

## Architecture

```
src/
├── main.tsx              # Entry point, ConvexProvider wrapper
├── App.tsx               # All views: tasks, post, wallet, chat, ratings, maps
├── hooks/
│   └── useRico.ts        # All Convex hooks: useUser, useTasks, useChat, etc.
└── lib/
    └── utils.ts          # Privacy zones, haversine, OSRM routing, constants

convex/
├── schema.ts             # 5 tables: users, tasks, bids, messages, ratings
├── users.ts              # Auto-wallet, profiles, transfers
├── tasks.ts              # Full lifecycle: create → bid → accept → deliver → confirm
├── chat.ts               # Real-time messaging
└── crons.ts              # Auto-refund expired tasks every 5 min
```

## Features

- **Auto-wallet** — no signup, wallet created on first visit
- **50 RICO airdrop** — instant balance for new users  
- **Post tasks** — item cost + delivery fee, privacy zone selector
- **Courier bidding** — GPS required, trip km calculated, reputation shown
- **Poster picks courier** — choose by price, distance, rating, reviews
- **Real-time chat** — opens after bid accepted, Convex subscriptions
- **Live tracking** — courier GPS sent every 5 seconds, map updates
- **Rating system** — 1-5 stars + comment after delivery
- **Escrow** — 1% protocol burn, auto-refund after 4 hours
- **Privacy zones** — fuzzy drop-off (100-500m), exact only for accepted courier
- **Location lock** — drop-off permanently locked at post time

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 + TypeScript + Vite |
| Backend | Convex (real-time database + serverless functions) |
| Maps | Leaflet + CARTO dark tiles + OSRM routing |
| Styling | CSS-in-JS (inline styles, Outfit + JetBrains Mono fonts) |

## Deploy

```bash
# Deploy Convex backend
npx convex deploy

# Build frontend
npm run build

# Host dist/ on Vercel, Netlify, or any static host
```
