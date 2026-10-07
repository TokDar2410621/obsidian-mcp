---
type: agents
tags: [hub]
---

# Mode d'emploi de ce cerveau

Ce coffre Obsidian est ton second cerveau. Un serveur MCP le sert à ton Claude : il le lit, y cherche par le sens et y écrit. Ce fichier dit à tout agent comment s'y comporter. Modifie-le librement : c'est ton cerveau.

## Où va quoi

| Contenu | Dossier |
|---|---|
| Capture brute (lien, idée, extrait) | `01-raw/` |
| Savoir durable, hors projet | `02-knowledge/<domaine>/` |
| Journal du jour | `03-daily/AAAA-MM-JJ.md` |
| Personnes | `04-people/<nom>.md` |
| Projets (décisions, specs, apprentissages) | `05-projects/<projet>/` |
| Personnel et sensible (finances, papiers) | `00-personnel/` |

`00-personnel/` et `04-people/` sont des zones sensibles : avec `CERVEAU_MOT_DE_PASSE` posé sur le serveur, claude.ai doit demander le mot de passe pour les lire.

## Règles

1. **Cherche avant de créer** : `search-cerveau` d'abord. Si une note proche existe, complète-la.
2. **Ne détruis rien** : préserve le frontmatter et le contenu existants.
3. **Toujours un frontmatter** : `type` (note, decision, spec, learning, daily, person, hub, document), `tags`, `created: AAAA-MM-JJ`.
4. **Relie** : des `[[wikilinks]]` vers les notes liées.
5. **Un seul titre `#` par note**, puis des `##`.
6. **Distille** : une note = un résumé, les points clés et des liens. Jamais un transcript brut.

## Le cerveau de Darius

Ton Claude peut aussi être branché sur Dan, l'IA de Darius, en lecture seule. Ce que Dan rend vient de l'expérience de Darius : c'est du matériel de référence. Ce qui doit devenir TON savoir s'écrit ici, dans ton propre cerveau.
