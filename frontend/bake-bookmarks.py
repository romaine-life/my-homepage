"""Refresh bookmarks-baked.json with descriptions for the SWA bypass deploy.

The SWA bypass (white-sea-0beb0bf1e.7.azurestaticapps.net) ships nelson-r1
bookmarks as a baked static file because the work network blocks
*.romaine.life and the live API is unreachable. The Cosmos tree itself
doesn't carry descriptions, so this script applies a path-keyed map after
each refresh so the fzt terminal has searchable context (env, cluster,
function) beyond the bare leaf names.

Refresh recipe (run on a machine with az login + the romaine-api.py helper):

    TOKEN=$(python "$PROFILE_DIR/scripts/romaine-api.py" mint-token --identity nelson-r1)
    curl -sS -H "Authorization: Bearer $TOKEN" \\
      https://fzt-frontend.romaine.life/fzt/tree/nelson-r1-bookmarks \\
      -o frontend/bookmarks-baked.json
    python frontend/bake-bookmarks.py
    npx --yes @azure/static-web-apps-cli deploy ./frontend \\
      --deployment-token "$(az staticwebapp secrets list --name my-homepage-app \\
        --resource-group homepage-rg --query properties.apiKey -o tsv)" \\
      --env default

When you add a new bookmark to the live tree, add a matching entry to
DESCRIPTIONS below before deploying or it'll ship without context.
"""
import json
import os

DESCRIPTIONS = {
    # ArgoCD — GitOps CD across Cloudmed clusters.
    "argocd": "ArgoCD — shared SCF GitOps console",
    "argocd/dev": "Cloudmed dev cluster GitOps",
    "argocd/ppe": "Cloudmed PPE cluster GitOps",
    "argocd/prd": "Cloudmed prod cluster GitOps",
    "argocd/central": "Cloudmed central prod cluster GitOps",

    # OSMS — observability stack (Grafana/Prometheus/Alertmanager per env).
    "OSMS/Grafana/dev": "Cloudmed dev cloudops Grafana — metrics & dashboards",
    "OSMS/Grafana/ppe": "Cloudmed PPE cloudops Grafana",
    "OSMS/Grafana/prd": "Cloudmed prod cloudops Grafana",
    "OSMS/Grafana/argus": "Argus observability Grafana (legacy stack)",
    "OSMS/Grafana/argus/stg": "Argus Grafana — staging",
    "OSMS/Prometheus/dev": "Cloudmed dev Prometheus — TSDB & query UI",
    "OSMS/Prometheus/ppe": "Cloudmed PPE Prometheus",
    "OSMS/Prometheus/prd": "Cloudmed prod Prometheus",
    "OSMS/Alertmanager/dev": "Cloudmed dev Alertmanager — fired alert routing",
    "OSMS/Alertmanager/ppe": "Cloudmed PPE Alertmanager",
    "OSMS/Alertmanager/prd": "Cloudmed prod Alertmanager",

    # Azure surfaces.
    "Azure Devops": "PhareOS Platform Engineering — ADO saved query",
    "Azure portal": "Azure portal — subscription root",
    "Azure portal/entra": "Microsoft Entra (Azure AD) overview blade",
    "Azure portal/PIM": "Privileged Identity Management — quick-start",

    # Vault — HashiCorp Vault on the standard TLS+8200 port across envs.
    "Vault": "HashiCorp Vault — prod (:8200)",
    "Vault/dev": "Vault — dev environment",
    "Vault/ppe": "Vault — PPE environment",
    "Vault/central": "Vault — central prod",

    # ServiceNow & team admin.
    "Service now": "ServiceNow home",
    "Service now/github": "ServiceNow — GitHub access request catalog item",
    "Team Calendar": "PhareOS Platform Engineering — SharePoint team calendar",

    # GitHub org + the two repos used most.
    "Github": "r1-development org — repo list",
    "Github/sso": "r1rcm GitHub Enterprise — SSO entry",
    "Github/Landing zones": "landing-zones repo — Terraform landing zones",
    "Github/outputs": "terraform-outputs-landing-zone repo",

    # Traefik — source repo + ingress dashboards for every AKS cluster.
    "Traefik": "r1-development/traefik repo",
    "Traefik/Cloudmed/dev": "Cloudmed dev — Traefik ingress dashboard",
    "Traefik/Cloudmed/ppe": "Cloudmed PPE — Traefik dashboard",
    "Traefik/Cloudmed/prd": "Cloudmed prod — Traefik dashboard",
    "Traefik/Cloudmed/central": "Cloudmed central — Traefik dashboard",
    "Traefik/Shared/shared-dev": "shared-dev AKS (eastus2) — Traefik",
    "Traefik/Shared/shared-stg": "shared-stg AKS — Traefik",
    "Traefik/Shared/shared-uat": "shared-uat AKS — Traefik",
    "Traefik/Shared/shared-prd": "shared-prd AKS — Traefik",
    "Traefik/Shared/shared-dev-cus": "shared-dev AKS (centralus) — Traefik",
    "Traefik/RCX/rcx-dev": "RCX dev AKS — Traefik",
    "Traefik/RCX/rcx-prp": "RCX pre-prod AKS — Traefik",
    "Traefik/RCX/rcx-prd": "RCX prod AKS — Traefik",
    "Traefik/Astro/astro-dev": "Astro dev AKS — Traefik",
    "Traefik/Astro/astro-prp": "Astro pre-prod AKS — Traefik",
    "Traefik/Astro/astro-prd": "Astro prod AKS — Traefik",
    "Traefik/PET/pet-dev": "PET dev AKS — Traefik",
    "Traefik/PET/pet-stg": "PET staging AKS — Traefik",
    "Traefik/PET/pet-prd": "PET prod AKS — Traefik",

    # Rest.
    "Terraform Cloud": "Terraform Cloud — CloudMed workspaces",
    "Confluence": "r1rcm Atlassian Confluence — wiki",
    "workday": "Workday HR portal",
    "misc/netskope": "Netskope — custom-apps settings",
    "misc/mongodb": "MongoDB Atlas — account login",
    "pagerduty": "r1rcm PagerDuty",
}


def apply(nodes, path=""):
    for n in nodes:
        p = f"{path}/{n['name']}" if path else n["name"]
        if p in DESCRIPTIONS:
            n["description"] = DESCRIPTIONS[p]
        if "children" in n:
            apply(n["children"], p)


def main():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bookmarks-baked.json")
    with open(path) as f:
        data = json.load(f)
    apply(data["tree"])
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"applied descriptions to {path}")


if __name__ == "__main__":
    main()
