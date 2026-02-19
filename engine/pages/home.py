"""
intended to be introduction page for the engine, with links to each step of the pipeline and brief descriptionsof what each step does. This is the first page users see when they access the app.
Example That I want islike: https://discord.com/ https://www.figma.com/
"""
import dash
from dash import html
import dash_bootstrap_components as dbc

dash.register_page(__name__, path='/', name='Home')

layout = dbc.Container([
    dbc.Row([
        dbc.Col([
            html.H1("Welcome to the Causal Extractor & KG Engine", className="display-4 mt-5"),
            html.P(
                "A comprehensive pipeline for extracting causal relationships from text, "
                "validating data, constructing Knowledge Graphs, and performing GraphRAG-assisted Code Generation.",
                className="lead mt-3"
            ),
            html.Hr(className="my-4"),
            html.P("Begin by extracting entities and relationships from your raw data."),
            dbc.Button("Getting Started ➜", href="/extraction", color="primary", size="lg", className="mt-3")
        ], width={"size": 8, "offset": 2}, className="text-center")
    ])
], fluid=True)