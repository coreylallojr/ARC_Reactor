import os
import sys

# ── Project info ──────────────────────────────────────────────────────────────
project   = 'ARC Reactor — J.A.R.V.I.S'
copyright = '2025, Stark Industries'
author    = 'Stark Industries R&D'
release   = '1.0.0'

# ── Extensions ────────────────────────────────────────────────────────────────
extensions = [
    'sphinx.ext.autodoc',
    'sphinx.ext.viewcode',
    'sphinx.ext.intersphinx',
    'sphinx.ext.githubpages',
]

# ── Paths ─────────────────────────────────────────────────────────────────────
templates_path   = ['_templates']
html_static_path = ['_static']
exclude_patterns = ['_build', 'Thumbs.db', '.DS_Store']

# ── Theme ─────────────────────────────────────────────────────────────────────
html_theme = 'sphinx_rtd_theme'

html_theme_options = {
    'logo_only':                  True,
    'navigation_depth':           4,
    'style_nav_header_background': '#000d1a',
    'prev_next_buttons_location': 'bottom',
    'style_external_links':       False,
    'collapse_navigation':        False,
    'sticky_navigation':          True,
    'includehidden':              True,
    'titles_only':                False,
}

# ── Branding ──────────────────────────────────────────────────────────────────
html_logo    = '_static/stark-logo.svg'
html_favicon = '_static/favicon.svg'
html_title   = 'J.A.R.V.I.S — ARC Reactor'

# ── Custom CSS ────────────────────────────────────────────────────────────────
html_css_files = ['custom.css']

# ── Source suffix ─────────────────────────────────────────────────────────────
source_suffix = '.rst'
master_doc    = 'index'

# ── Syntax highlighting ───────────────────────────────────────────────────────
pygments_style = 'monokai'

# ── HTML output extras ────────────────────────────────────────────────────────
html_show_sourcelink   = False
html_show_sphinx_footer = False
html_copy_source       = False

html_context = {
    'github_user': 'coreylallojr',
    'github_repo': 'ARC_Reactor',
    'github_version': 'main',
    'conf_py_path': '/docs/',
    'display_github': True,
}
