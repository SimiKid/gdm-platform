FROM etherpad/etherpad:3.3.5
USER root
COPY infra/etherpad/ /opt/gdm/
RUN node /opt/gdm/install.cjs
USER etherpad
EXPOSE 9001 9002
HEALTHCHECK --interval=5s --timeout=3s CMD node -e "fetch('http://localhost:9002/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/opt/gdm/supervisor.cjs"]
