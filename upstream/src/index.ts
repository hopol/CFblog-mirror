import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './types';
import { getSiteSettings } from './utils';
import posts from './routes/posts';
import categories from './routes/categories';
import tags from './routes/tags';
import media from './routes/media';
import users from './routes/users';
import links from './routes/links';
import linkCategories from './routes/link-categories';
import comments from './routes/comments';
import pages from './routes/pages';
import settings from './routes/settings';
import moments from './routes/moments';
import imports from './routes/import';
import { registerPublicSiteRoutes, renderPublicHome } from './public-site';
import { bumpPublicCacheVersion } from './public-site/cache';

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  await next();

  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'SAMEORIGIN');

  if (new URL(c.req.url).protocol === 'https:') {
    c.header('Strict-Transport-Security', 'max-age=31536000');
  }

  if (c.req.path === '/wp-admin') {
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; " +
      "form-action 'self'; frame-ancestors 'none'; frame-src 'self'; img-src 'self' data: https:; " +
      "object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'"
    );
  }
});

// CORS middleware
app.use('*', cors({
  origin: (origin, c) => origin === new URL(c.req.url).origin ? origin : undefined,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  exposeHeaders: ['X-WP-Total', 'X-WP-TotalPages', 'Link'],
  maxAge: 600,
}));

// Any successful authenticated write may change what the public site shows,
// so invalidate every cached public view at once.
app.use('/wp-json/wp/v2/*', async (c, next) => {
  await next();

  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.res.status < 400 && c.get('user')) {
    await bumpPublicCacheVersion(c.env);
  }
});

app.get('/', renderPublicHome);

// WordPress REST API root - Discovery endpoint
async function renderApiIndex(c: Context<AppEnv>) {
  const siteSettings = await getSiteSettings(c.env);
  return c.json({
    name: siteSettings.site_title || 'CFBlog',
    description: siteSettings.site_description || 'WordPress-like headless CMS powered by Cloudflare Workers',
    url: siteSettings.site_url || 'http://localhost:8787',
    home: siteSettings.site_url || 'http://localhost:8787',
    gmt_offset: 0,
    timezone_string: 'UTC',
    namespaces: ['wp/v2'],
    authentication: {
      oauth1: false,
      oauth2: false,
      jwt: true
    },
    routes: {
      '/wp-json/': {
        namespace: '',
        methods: ['GET'],
        endpoints: [
          {
            methods: ['GET'],
            args: {
              context: {
                default: 'view',
                required: false
              }
            }
          }
        ],
        _links: {
          self: `${siteSettings.site_url || 'http://localhost:8787'}/wp-json/`
        }
      },
      '/wp-json/wp/v2': {
        methods: ['GET']
      },
      '/wp-json/wp/v2/posts': {
        methods: ['GET', 'POST']
      },
      '/wp-json/wp/v2/posts/(?P<id>[\\d]+)': {
        methods: ['GET', 'PUT', 'DELETE']
      },
      '/wp-json/wp/v2/pages': {
        methods: ['GET', 'POST']
      },
      '/wp-json/wp/v2/pages/(?P<id>[\\d]+)': {
        methods: ['GET', 'PUT', 'DELETE']
      },
      '/wp-json/wp/v2/categories': {
        methods: ['GET', 'POST']
      },
      '/wp-json/wp/v2/categories/(?P<id>[\\d]+)': {
        methods: ['GET', 'PUT', 'DELETE']
      },
      '/wp-json/wp/v2/tags': {
        methods: ['GET', 'POST']
      },
      '/wp-json/wp/v2/tags/(?P<id>[\\d]+)': {
        methods: ['GET', 'PUT', 'DELETE']
      },
      '/wp-json/wp/v2/media': {
        methods: ['GET', 'POST']
      },
      '/wp-json/wp/v2/media/(?P<id>[\\d]+)': {
        methods: ['GET', 'PUT', 'DELETE']
      },
      '/wp-json/wp/v2/users': {
        methods: ['GET', 'POST']
      },
      '/wp-json/wp/v2/users/(?P<id>[\\d]+)': {
        methods: ['GET', 'PUT', 'DELETE']
      },
      '/wp-json/wp/v2/links': {
        methods: ['GET', 'POST']
      },
      '/wp-json/wp/v2/links/(?P<id>[\\d]+)': {
        methods: ['GET', 'PUT', 'DELETE']
      },
      '/wp-json/wp/v2/link-categories': {
        methods: ['GET', 'POST']
      },
      '/wp-json/wp/v2/link-categories/(?P<id>[\\d]+)': {
        methods: ['GET', 'PUT', 'DELETE']
      },
      '/wp-json/wp/v2/comments': {
        methods: ['GET', 'POST']
      },
      '/wp-json/wp/v2/comments/(?P<id>[\\d]+)': {
        methods: ['GET', 'PUT', 'DELETE']
      },
      '/wp-json/wp/v2/import': {
        methods: ['GET', 'POST']
      },
      '/wp-json/wp/v2/settings': {
        methods: ['GET', 'PUT']
      }
    }
  });
}

// WordPress REST API root with trailing slash (alias)

app.get('/wp-json', renderApiIndex);
app.get('/wp-json/', renderApiIndex);


// WordPress REST API v2 info
app.get('/wp-json/wp/v2', (c) => {
  return c.json({
    namespace: 'wp/v2',
    routes: {
      '/wp/v2': {
        namespace: 'wp/v2',
        methods: ['GET']
      },
      '/wp/v2/posts': {
        namespace: 'wp/v2',
        methods: ['GET', 'POST']
      },
      '/wp/v2/categories': {
        namespace: 'wp/v2',
        methods: ['GET', 'POST']
      },
      '/wp/v2/tags': {
        namespace: 'wp/v2',
        methods: ['GET', 'POST']
      },
      '/wp/v2/media': {
        namespace: 'wp/v2',
        methods: ['GET', 'POST']
      },
      '/wp/v2/users': {
        namespace: 'wp/v2',
        methods: ['GET', 'POST']
      },
      '/wp/v2/import': {
        namespace: 'wp/v2',
        methods: ['GET', 'POST']
      }
    }
  });
});

// Mount routes
app.route('/wp-json/wp/v2/posts', posts);
app.route('/wp-json/wp/v2/pages', pages);
app.route('/wp-json/wp/v2/categories', categories);
app.route('/wp-json/wp/v2/tags', tags);
app.route('/wp-json/wp/v2/media', media);
app.route('/wp-json/wp/v2/users', users);
app.route('/wp-json/wp/v2/links', links);
app.route('/wp-json/wp/v2/link-categories', linkCategories);
app.route('/wp-json/wp/v2/comments', comments);
app.route('/wp-json/wp/v2/import', imports);
app.route('/wp-json/wp/v2/settings', settings);
app.route('/wp-json/wp/v2/moments', moments);

// Serve media files from R2
app.get('/media/*', async (c) => {
  try {
    // Extract the R2 key from the URL path
    // URL format: /media/uploads/2025/10/filename.jpg
    const path = c.req.path.replace('/media/', '');

    // Get the file from R2
    const object = await c.env.MEDIA.get(path);

    if (!object) {
      return c.text('File not found', 404);
    }

    // Get the content type from R2 metadata
    const contentType = object.httpMetadata?.contentType || 'application/octet-stream';

    // Return the file with appropriate headers
    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    console.error('Error serving media file:', error);
    return c.text('Internal server error', 500);
  }
});

// Short admin alias.
app.get('/admin', (c) => c.redirect('/wp-admin', 302));

// Vue admin entry. The SPA uses hash routing, so the Worker only serves one shell.
app.get('/wp-admin', async (c) => {
  const assetUrl = new URL(c.req.url);
  assetUrl.pathname = '/_cfblog/admin/index.html';
  assetUrl.search = '';
  return c.env.ASSETS.fetch(new Request(assetUrl, {
    method: 'GET',
    headers: c.req.raw.headers,
  }));
});
app.get('/wp-admin/', (c) => c.redirect('/wp-admin', 302));

// Preserve old bookmarks while serving the Vue admin only.
app.get('/wp-admin/legacy', (c) => c.redirect('/wp-admin', 302));

registerPublicSiteRoutes(app);

app.notFound((c) => c.text('Not Found', 404));

export default app;
