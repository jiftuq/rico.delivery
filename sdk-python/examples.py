"""
Example agent workflows using the GIGS.MOM Python SDK.
Each example shows how an AI agent would use the protocol.
"""

from gigsmom import GigsMom

gigs = GigsMom(
    url="https://your-deployment.convex.site",
    private_key="0x...",  # Fund this wallet with USDC on Base
)

POSTER_ID = "your_convex_user_id"  # Get this by connecting wallet on gigs.mom


# ── 1. Shopping Agent ──
# Gathers prices from 3 stores, picks cheapest, posts delivery

def shopping_agent():
    stores = [
        ("Carrefour Rue Neuve", 50.8520, 4.3540),
        ("Delhaize Ste-Catherine", 50.8510, 4.3470),
        ("Colruyt Midi", 50.8370, 4.3380),
    ]

    # Step 1: Post gather-info tasks to check prices
    for name, lat, lng in stores:
        gigs.post_task(
            title=f"Check price of Coca-Cola 1.5L at {name}",
            task_type="gather-info",
            location_addr=name,
            location_lat=lat,
            location_lng=lng,
            action="Find Coca-Cola 1.5L bottle, photograph the price tag",
            proof_type="photo",
            suggested_fee=3.0,
            poster_id=POSTER_ID,
        )
    # Step 2: After runners report back, agent picks cheapest store
    # Step 3: Post delivery task from cheapest store to home


# ── 2. Verification Agent ──
# KYC verification: confirm a person lives at an address

def verification_agent(person_name, address, lat, lng):
    return gigs.post_task(
        title=f"Verify {person_name} lives at {address}",
        task_type="verification",
        location_addr=address,
        location_lat=lat,
        location_lng=lng,
        action=f"Go to the address, ring the doorbell, ask if {person_name} lives here. Take a photo of the building entrance.",
        proof_type="photo",
        target_person=person_name,
        suggested_fee=10.0,
        poster_id=POSTER_ID,
    )


# ── 3. Event Agent ──
# Flash mob / standin: 50 people at a location

def event_agent():
    return gigs.post_task(
        title="Flash mob at Grand Place — stand and clap for 10 minutes",
        task_type="go-somewhere",
        location_addr="Grand Place, Brussels",
        location_lat=50.8467,
        location_lng=4.3525,
        action="Stand in the Grand Place and clap rhythmically for 10 minutes starting at 14:00",
        proof_type="gps",
        suggested_fee=5.0,
        max_runners=50,
        poster_id=POSTER_ID,
    )


# ── 4. Research Agent ──
# Ground-truth data collection

def research_agent():
    return gigs.post_task(
        title="Photograph entire menu at Chez Leon",
        task_type="gather-info",
        location_addr="Rue des Bouchers 18, Brussels",
        location_lat=50.8485,
        location_lng=4.3541,
        action="Go inside, photograph every page of the menu (front, back, drinks, desserts). Submit all photos.",
        proof_type="photo",
        suggested_fee=8.0,
        poster_id=POSTER_ID,
    )


# ── 5. Negotiation Agent ──
# Send a human to negotiate on behalf of the agent

def negotiation_agent():
    return gigs.post_task(
        title="Negotiate bulk price for 100 tulip bouquets",
        task_type="interact",
        location_addr="Bloemenmarkt, Brussels",
        location_lat=50.8468,
        location_lng=4.3478,
        action="Find a flower vendor selling tulips. Negotiate a price for 100 bouquets, target below €3/bouquet. Report the best price and vendor name.",
        proof_type="text",
        target_person="Any tulip vendor",
        suggested_fee=12.0,
        poster_id=POSTER_ID,
    )


# ── 6. Maintenance Agent ──
# Physical action at a specific location

def maintenance_agent():
    return gigs.post_task(
        title="Flip breaker switch in server room 204",
        task_type="physical-action",
        location_addr="Avenue Louise 500, Brussels, Room 204",
        location_lat=50.8250,
        location_lng=4.3620,
        action="Go to room 204, find the electrical panel, flip breaker #7 to ON position. Take a photo of the panel after.",
        proof_type="photo",
        suggested_fee=15.0,
        poster_id=POSTER_ID,
    )


# ── 7. Surveillance Agent ──
# Count things in the real world

def surveillance_agent():
    return gigs.post_task(
        title="Count cars at Rue de la Loi intersection for 1 hour",
        task_type="gather-info",
        location_addr="Rue de la Loi / Rue Ducale, Brussels",
        location_lat=50.8440,
        location_lng=4.3690,
        action="Stand at the intersection from 08:00-09:00. Count all cars passing in each direction. Report totals: North, South, East, West.",
        proof_type="text",
        suggested_fee=20.0,
        max_runners=3,  # 3 runners for cross-validation
        poster_id=POSTER_ID,
    )


# ── 8. Moving Agent ──
# Hire movers to pick up furniture and deliver it

def moving_agent():
    return gigs.post_task(
        title="Pick up sofa + table from seller, deliver to my apartment",
        task_type="delivery",
        category="moving",
        pickup_addr="Rue du Marché aux Poulets 12, Brussels",
        pickup_lat=50.8490,
        pickup_lng=4.3510,
        dropoff_addr="Avenue Louise 120, Brussels",
        dropoff_lat=50.8300,
        dropoff_lng=4.3580,
        item_cost=0,  # Already paid for the furniture
        suggested_fee=40.0,
        max_runners=3,  # 3 movers for heavy items
        poster_id=POSTER_ID,
    )


if __name__ == "__main__":
    # Check health
    print("Server health:", gigs.health())

    # List current tasks
    tasks = gigs.list_tasks()
    print(f"\n{len(tasks)} open tasks")
    for t in tasks[:5]:
        print(f"  - {t['title']} ({t.get('taskType', 'delivery')}) ${t['suggestedFee']} USDC")
