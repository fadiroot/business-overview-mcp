from sqlalchemy import Column, Integer, String, ForeignKey
from sqlalchemy.orm import relationship, declarative_base
Base = declarative_base()

class Tenant(Base):
    __tablename__ = "tenants"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    projects = relationship("Project", back_populates="tenant")

class Project(Base):
    __tablename__ = "projects"
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"))
    title = Column(String)
    tenant = relationship("Tenant", back_populates="projects")
