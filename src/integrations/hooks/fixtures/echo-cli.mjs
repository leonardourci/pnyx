// Stands in for pnyx-axi in the hook script: prints the command line the script ran it with.
process.stdout.write(process.argv.slice(2).join(' '))
