"""
Example: Plain LangChain agent with RICO workflow tools (no AgentKit needed).

This works with any LLM and doesn't require Coinbase AgentKit.
Tasks are paid from your prepaid RICO balance (top it up at rico.delivery under Wallet).

Every task is a workflow: ordered steps with actions, locations, and proof types.

Requirements:
    pip install langchain-rico[langchain]

Environment:
    OPENAI_API_KEY=sk-...
    RICO_API_KEY=rico_...  (create at rico.delivery under Wallet)
"""

from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent
from langchain_rico import RicoToolkit

# Setup
toolkit = RicoToolkit()  # reads from env vars
tools = toolkit.get_tools()
llm = ChatOpenAI(model="gpt-4o")

agent = create_react_agent(
    llm,
    tools=tools,
    prompt=(
        "You are an AI agent that can post workflow-based tasks for humans via RICO. "
        "RICO is your physical execution layer — when you need something done in the "
        "real world, you define a workflow as a sequence of steps.\n\n"
        "Each step: {action, location_addr, proof_type, requirements}\n"
        "Proof types: photo, video, text, gps, none\n"
        "Requirements: van, camera, ID, etc.\n\n"
        "Humans bid on the workflow, complete each step with proof, and get paid in USDC on Base."
    ),
)

if __name__ == "__main__":
    prompts = [
        # Moving furniture (workflow: 4 steps, 2 runners, requires van)
        "I bought a couch on marketplace at Rue Neuve 45 Brussels. "
        "I need 2 movers with a van to pick it up and bring it to Avenue Louise 120. "
        "",

        # Price comparison (workflow: 3 steps at different stores)
        "Check the price of iPhone 16 at 3 stores near Grand Place Brussels: "
        "FNAC, MediaMarkt, and Apple Store. Take a photo of each price tag. "
        "",

        # Verification (workflow: 2 steps)
        "Verify that Jean Dupont lives at Rue du Marché 18, Brussels. "
        "Go to the address, confirm the name on the mailbox, and take a photo. "
        "",
    ]

    result = agent.invoke({
        "messages": [{"role": "user", "content": prompts[0]}]
    })

    for msg in result["messages"]:
        print(f"\n{msg.type}: {msg.content}")
