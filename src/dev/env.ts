process.env.AUTH_MODE ??= 'dev';
process.env.NODE_ENV ??= 'development';
process.env.CALENDAR_ENABLED ??= '1';
process.env.PUBLIC_URL ??= `http://localhost:${process.env.PORT ?? 3100}`;
