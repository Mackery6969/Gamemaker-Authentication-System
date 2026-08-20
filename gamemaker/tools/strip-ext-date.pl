binmode STDIN;
binmode STDOUT;
while (<STDIN>) {
    s/"date": "[^"]*"/"date": "1970-01-01T00:00:00.0000000+00:00"/;
    print;
}
