import dash
import dash_bootstrap_components as dbc
from dash import html

app = dash.Dash(__name__, use_pages=True, external_stylesheets=[dbc.themes.DARKLY])

# Global Navigation Bar
navbar = dbc.NavbarSimple(
    children=[
        dbc.NavItem(dbc.NavLink("Home", href="/")),
        dbc.NavItem(dbc.NavLink("Extraction", href="/extraction")),
        dbc.NavItem(dbc.NavLink("Visualize", href="/visualize")),
        dbc.NavItem(dbc.NavLink("Code Generation", href="/code-generation")),
    ],
    brand="KG Production Studio",
    brand_href="/",
    color="primary",
    dark=True,
    className="mb-4"
)

app.layout = html.Div([
    navbar,
    dash.page_container
])

if __name__ == '__main__':
    app.run(debug=True, port=8050)