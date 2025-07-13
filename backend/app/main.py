from fastapi import FastAPI, HTTPException
from pathlib import Path
import os, tempfile, json, requests
from git import Repo

app = FastAPI()

GH_TOKEN     = os.environ["GH_TOKEN"]
TARGET_REPO  = os.environ["TARGET_REPO"]     #  "danni/ai-suggestions-prototype"
BASE_BRANCH  = os.getenv("BASE_BRANCH", "main")

# Remote-URL med inbäddat token  (HTTPS skonar brandväggar)
REMOTE_URL = f"https://{GH_TOKEN}:x-oauth-basic@github.com/{TARGET_REPO}.git"


@app.post("/figma-hook")
async def figma_hook(payload: dict):
    """
    Tar emot (just nu) valfri JSON → gör test-PR.
    Senare ersätter vi detta med Figma-payload + LLM-kod.
    """
    # 1. Klona repo till temporär mapp
    tmp = tempfile.mkdtemp()
    repo = Repo.clone_from(REMOTE_URL, tmp, branch=BASE_BRANCH)

    # 2. Skapa en trivial fil så vi ser diff i PR:n
    new_file = Path(tmp) / "ai_test.txt"
    new_file.write_text("Hello from design-bot! 🎉")

    # 3. Ny gren + commit + push
    branch_name = "ai/test-pr"
    repo.git.checkout("-b", branch_name)
    repo.git.add(new_file.as_posix())
    repo.index.commit("chore(bot): test PR from design-bot")
    repo.remote("origin").push(refspec=f"{branch_name}:{branch_name}")

    # 4. Öppna Pull Request via GitHub REST
    headers = {
        "Authorization": f"token {GH_TOKEN}",
        "Accept": "application/vnd.github+json",
    }
    pr_resp = requests.post(
        f"https://api.github.com/repos/{TARGET_REPO}/pulls",
        headers=headers,
        json={
            "title": "feat: first test PR from design-bot",
            "head": branch_name,
            "base": BASE_BRANCH,
            "body": "🚀 Kedjan Figma → Backend → GitHub fungerar!",
        },
        timeout=15,
    )

    if pr_resp.status_code >= 300:
        raise HTTPException(
            status_code=500,
            detail=f"GitHub PR-call misslyckades: {pr_resp.text}",
        )

    pr_url = pr_resp.json()["html_url"]
    print("✅ PR skapad:", pr_url)
    return {"pr_url": pr_url}
