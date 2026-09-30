#!/bin/sh
npm run lint --silent 2>&1 | tail -5
