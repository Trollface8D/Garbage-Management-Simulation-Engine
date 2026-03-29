# Phototype Design Specification

## Overview
This document explains the behavior and design intent of the interactive text block editor prototype.
The goal is to demonstrate block-level editing interactions for a future AI-assisted writing workflow.

The prototype currently runs in a single HTML file using React in the browser and focuses on interaction flow rather than production architecture.

## Product Goal
Provide users with a lightweight editor where they can:
- Split content at an exact click position
- Select multiple blocks and join them into one block
- Rechunk the full document automatically

The editor should feel predictable and explicit, especially when operations can rewrite document structure.

## Core Data Model
The editor keeps a list of text blocks.
Each block contains:
- id: unique identifier
- text: editable content string

Runtime state includes:
- activeIndex: the currently focused block
- isCutMode: whether split-by-click mode is armed
- selectedForJoin: indexes of blocks selected for merge

## Implemented Interaction Design

### 1) Cut by Next Click
Behavior:
- User presses Cut button once to arm cut mode.
- While cut mode is active, user clicks inside any block.
- The block is split at the clicked caret position into two blocks.
- Cut mode automatically turns off after one split.

Why:
- Reduces dependency on text selection.
- Makes splitting intentional and location-based.

### 2) Multi-Select Join
Behavior:
- Each block has a Join checkbox.
- User can select two or more blocks.
- Pressing Join Selected merges chosen blocks in top-to-bottom order.
- Selected blocks are replaced by one merged block inserted at the first selected position.

Why:
- Supports combining non-trivial document fragments.
- Removes the old limitation of joining only adjacent pair interactions.

### 3) Autochunk (Prototype Logic)
Behavior:
- User presses Autochunk.
- System shows a warning confirmation because the operation rewrites block structure.
- If confirmed, all block text is flattened into one document string.
- The text is split into fixed chunks of 20 words.
- The editor replaces all blocks with these new chunks.
- Selection and temporary modes are reset.

Why:
- Demonstrates end-to-end rechunking flow.
- Provides a temporary deterministic stand-in for AI chunking.

## Important Warning and UX Constraint
Autochunk must explicitly warn users before running because it can reset their current block arrangement.
The warning is intentional and should stay in future versions, even when chunking becomes AI-based.

## Current Prototype Limitation
The chunking algorithm is not semantic.
It uses a fixed 20-word rule only to simulate behavior.

## Intended Future LLM Behavior
Replace fixed-word chunking with LLM semantic chunking.
Desired AI chunking characteristics:
- Preserve meaning and topic boundaries
- Avoid splitting mid-thought
- Keep chunks reasonably sized for downstream processing
- Maintain stable chunk ordering
- Be robust to punctuation and noisy user edits

Potential strategy:
1. Concatenate full document text
2. Ask LLM to segment into coherent chunks with boundary rationale
3. Convert returned chunks into editor blocks
4. Preserve deterministic fallback when model fails

## Prompt Guidance for LLM
When using this prototype context as an instruction prompt, communicate these requirements:
- Keep Cut as a one-shot armed interaction that splits by next click position
- Keep Join as multi-select merge for two or more blocks
- Keep Autochunk as full-document operation, not per-block
- Keep warning before destructive rechunking
- Replace 20-word heuristic with semantic LLM chunking in production implementation

## Acceptance Criteria
A future implementation is acceptable when:
- Split happens at clicked caret position after arming cut mode
- Join merges selected blocks in visual order
- Autochunk processes the entire document and resets temporary UI selections
- User confirmation appears before rechunking
- LLM-based chunking replaces fixed 20-word chunking while preserving coherence

## Scope Notes
In scope:
- Interaction behavior and user flow
- Document transformation rules
- Transition path from prototype chunking to AI chunking

Out of scope:
- Backend API design
- Persistence and version history
- Authentication and multi-user collaboration
