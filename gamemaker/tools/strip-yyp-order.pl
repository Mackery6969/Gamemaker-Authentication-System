binmode STDIN;
binmode STDOUT;
while (<STDIN>) {
    s/"order":\d+,/"order":0,/g;
    print;
}
